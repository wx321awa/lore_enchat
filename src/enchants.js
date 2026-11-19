"use strict";
/**
 * 词条注册表
 *
 * 加词条 = 往 ENCHANTS 里加一项（或直接用 makeOnHitEffect 造一个），字段含义：
 *   id        内部名（配置里做键）
 *   name      游戏里显示的名字（lore 里写它）
 *   alias     别名
 *   slot      适用槽位：weapon/sword/axe/bow/pickaxe/armor/helmet/chest/legs/boots/hand/any
 *   maxLevel  最高等级
 *   trigger   hit(近战命中)/hurt(自己受伤)/projectile(箭命中)/kill(击杀)/tick(轮询)/mine(挖方块)
 *   chance    各等级触发概率（%）
 *   params    其它数值（可在 config 覆盖）
 *   desc      一句话说明
 *   run(ctx)  触发时干什么；返回 false = 拦截这次事件
 *
 * ctx 里能用：player / target / level / damage / cause / rng / cfg / params
 *            say() / sound() / effect() / healMe() / hurtTarget() / lightningAt() / targetPos()
 */
const { byLevel, roman } = require("plugins/lore_enchant/src/util");

/** 常用药水效果 id（别凭记忆改，见 LSE 文档对照表） */
const FX = {
    SPEED: 1,
    SLOWNESS: 2,
    HASTE: 3,
    MINING_FATIGUE: 4,
    STRENGTH: 5,
    JUMP: 8,
    REGENERATION: 10,
    RESISTANCE: 11,
    FIRE_RESISTANCE: 12,
    WATER_BREATHING: 13,
    INVISIBILITY: 14,
    BLINDNESS: 15,
    NIGHT_VISION: 16,
    HUNGER: 17,
    WEAKNESS: 18,
    POISON: 19,
    WITHER: 20,
    HEALTH_BOOST: 21,
    ABSORPTION: 22,
    SATURATION: 23,
    LEVITATION: 24,
    FATAL_POISON: 25,
    DARKNESS: 30,
};

/** 统一的「每级 10%，共 10 级」概率表 */
const TEN_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/** 从 step% 开始，每级 +step%，直到 100% → 返回概率数组（等级数 = 100/step） */
function stepsUpTo100(step) {
    const out = [];
    for (let p = step; p <= 100; p += step) out.push(p);
    if (out.length === 0 || out[out.length - 1] !== 100) out.push(100);
    return out;
}

/** 混沌类词条可以抽到的效果池（顺序就是抽取顺序） */
const CHAOS_POOL = ['thunder', 'wither', 'blind', 'famine', 'chill', 'ascend', 'raid'];

/**
 * 执行若干个词条的效果（给「混沌打击 / 完全混沌」用）。
 * 用子上下文：沿用当前的 player/target/level，但把参数换成子词条自己的默认值，
 * 并把「触发提示」静音，避免一次触发刷 7 条消息（混沌自己会报一条）。
 * @returns {number} 真正执行成功的子效果个数
 */
function runSubEffects(ctx, ids) {
    const quietCfg = Object.assign({}, (ctx.cfg || {}), { announce_triggers: false });
    let done = 0;
    for (let i = 0; i < ids.length; i++) {
        const def = BY_ID.get(ids[i]);
        if (def == null || typeof def.run !== 'function') continue;
        const sub = Object.assign({}, ctx, {
            params: Object.assign({}, def.params || {}),
            cfg: quietCfg,
        });
        try {
            def.run(sub);
            done++;
        } catch (e) {
            log('[lore_enchant] 混沌子效果出错 ' + ids[i] + ': ' + e);
        }
    }
    return done;
}

/**
 * 造一个「命中时给对方挂某个状态」的词条。
 * 淬毒 / 死亡 / 侵袭 / 饥荒 / 冰冻 / 飞升 / 掠袭 都是这个形状，只有效果 id、名字、时长不同。
 *
 * @param {Object} o
 *   o.id / o.name / o.alias / o.effect(FX 里的 id) / o.ticks / o.desc / o.say
 *   o.fixedAmplifier  固定强度（不跟词条等级走）。不给就按 amp = 等级。
 */
function makeOnHitEffect(o) {
    const ticks = isFinite(Number(o.ticks)) ? Number(o.ticks) : 60;
    const fixed = isFinite(Number(o.fixedAmplifier)) ? Math.floor(Number(o.fixedAmplifier)) : null;
    return {
        id: o.id,
        name: o.name,
        alias: o.alias || [o.name, o.id],
        slot: o.slot || 'weapon',
        maxLevel: 10,
        trigger: o.trigger || 'hit',
        chance: TEN_STEPS.slice(),
        params: (fixed == null)
            ? { ticks: ticks, amplifierOffset: 0 }
            : { ticks: ticks, fixedAmplifier: fixed },
        desc: o.desc,
        run(ctx) {
            const useTicks = Number(ctx.params.ticks) || ticks;

            let amp;
            const fixedNow = Number(ctx.params.fixedAmplifier);
            if (isFinite(fixedNow)) {
                // 固定强度：不管词条几级，都挂同一个等级（上限 255）
                amp = Math.min(255, Math.max(0, Math.floor(fixedNow)));
            } else {
                const offset = isFinite(Number(ctx.params.amplifierOffset)) ? Number(ctx.params.amplifierOffset) : 0;
                amp = Math.max(0, Math.floor(ctx.level + offset));
            }

            const ok = ctx.effect(ctx.target, o.effect, useTicks, amp);
            if (ctx.cfg == null || ctx.cfg.announce_triggers !== false) {
                ctx.say(ok ? o.say : ('§c' + o.name + '：附加效果失败'));
            }
            return true;
        },
    };
}

const ENCHANTS = [
    // ------------------------------------------------------------ 雷神（召唤闪电）
    {
        id: 'thunder',
        name: '雷神',
        alias: ['雷神', '雷神之怒', 'thunder', 'lightning'],
        slot: 'weapon',
        maxLevel: 10,
        trigger: 'hit',
        chance: TEN_STEPS.slice(),
        // 冷却 0 = 不防连点：满级 100% 时每一下都要出闪电
        params: { cooldownMs: 0 },
        desc: '命中时概率在目标位置召唤闪电',
        run(ctx) {
            const pos = ctx.targetPos();
            if (pos == null) {
                ctx.say('§c雷神：找不到目标坐标');
                return 'no-pos';
            }
            const ok = ctx.lightningAt(pos, ctx.targetDim(), ctx.params.mode);
            if (ok === false) {
                ctx.say('§c雷神：召唤闪电失败（看控制台）');
                return 'failed';
            }
            if (ctx.cfg == null || ctx.cfg.announce_triggers !== false) ctx.say('§e雷神之力！！！');
            return true;
        },
    },

    // ------------------------------------------------------------ 状态类（全走工厂）
    makeOnHitEffect({
        id: 'poison',
        name: '淬毒',
        // 别把「毒」单字当别名：lore 里「百毒不侵」会误触发
        alias: ['淬毒', '剧毒', 'poison', 'venom'],
        effect: FX.POISON,
        desc: '命中时概率让目标中毒 3 秒（等级越高越强）',
        say: '§2淬毒！！！',
    }),
    makeOnHitEffect({
        id: 'wither',
        name: '死亡',
        alias: ['死亡', '凋零', 'wither', 'decay'],
        effect: FX.WITHER,
        desc: '命中时概率让目标凋零 3 秒（等级越高越强）',
        say: '§8死亡！！！',
    }),
    makeOnHitEffect({
        id: 'blind',
        name: '侵袭',
        alias: ['侵袭', 'blind', 'blindness'],
        effect: FX.BLINDNESS,
        desc: '命中时概率让目标失明 3 秒（等级越高越强）',
        say: '§7侵袭！！！',
    }),
    makeOnHitEffect({
        id: 'famine',
        name: '饥荒',
        alias: ['饥荒', 'famine', 'hunger'],
        effect: FX.HUNGER,
        // 固定强度：不管词条几级，饥饿都按 amp=254 挂（游戏里显示「饥饿 255」）。
        // 想严格按 amp=255 就把 config 里的 params.fixedAmplifier 改成 255。
        fixedAmplifier: 254,
        desc: '命中时概率让目标饥饿 3 秒（强度固定为 255，不随等级变化）',
        say: '§6饥荒！！！',
    }),
    makeOnHitEffect({
        id: 'chill',
        name: '冰冻',
        alias: ['冰冻', '冰封', 'chill', 'freeze'],
        effect: FX.SLOWNESS,
        desc: '命中时概率让目标缓慢 3 秒（等级越高越强）',
        say: '§b冰冻！！！',
    }),
    makeOnHitEffect({
        id: 'ascend',
        name: '飞升',
        alias: ['飞升', '升空', 'ascend', 'levitate'],
        effect: FX.LEVITATION,
        desc: '命中时概率让目标漂浮 3 秒（等级越高越强）',
        say: '§d飞升！！！',
    }),
    makeOnHitEffect({
        id: 'raid',
        name: '掠袭',
        alias: ['掠袭', '黑暗侵袭', 'raid', 'darkness'],
        effect: FX.DARKNESS,
        desc: '命中时概率让目标陷入黑暗 3 秒（等级越高越强）',
        say: '§5掠袭！！！',
    }),

    // ------------------------------------------------------------ 秒杀（红色）
    {
        id: 'xiying_kill',
        name: 'XiYingKill',
        alias: ['XiYingKill', 'xiyingkill', '秒杀'],
        slot: 'weapon',
        maxLevel: 11,
        trigger: 'hit',
        /**
         * 1 级 3%，之后每级 +10%：
         * 3 / 13 / 23 / 33 / 43 / 53 / 63 / 73 / 83 / 93 / 100
         * 11 级正好到 100%（10 级是 93%，要满就得 11 级）
         */
        chance: [3, 13, 23, 33, 43, 53, 63, 73, 83, 93, 100],
        // 词条在 lore 里的颜色（红色）
        color: '§c',
        params: { announce: true, message: '§c抹杀目标' },
        desc: '命中时概率直接秒杀目标（1 级 3%，每级 +10%，11 级 100%）',
        run(ctx) {
            const ok = ctx.killTarget();

            // 播报：**只发给触发这个词条的玩家自己**（不是全服），默认打开
            const announce = (ctx.params.announce === undefined) ? true : ctx.params.announce !== false;
            if (announce) {
                const msg = String(ctx.params.message || '§c抹杀目标');
                ctx.say(msg);
            }

            if (ok !== true && (ctx.cfg == null || ctx.cfg.announce_triggers !== false)) {
                ctx.say('§cXiYingKill：秒杀失败（目标可能已死或不可杀）');
            }
            return true;
        },
    },

    // ------------------------------------------------------------ 吸血（固定 3 点血）
    {
        id: 'kuanggu',
        name: '狂骨',
        alias: ['狂骨', 'kuanggu', 'bone'],
        slot: 'weapon',
        maxLevel: 20,
        trigger: 'hit',
        // 1 级 5%，每级 +5%：5 / 10 / … / 100（20 级正好满）
        chance: stepsUpTo100(5),
        params: { heal: 3, announce: false, message: '§c狂骨！！！' },
        desc: '命中时概率回复 3 点生命（回血量固定 3 点，只有概率随等级涨）',
        run(ctx) {
            const hp = isFinite(Number(ctx.params.heal)) ? Number(ctx.params.heal) : 3;
            const ok = ctx.healHp(hp);

            // 提示默认关（想开就把 params.announce 改成 true）
            if (ctx.params.announce === true) {
                ctx.say(ok ? String(ctx.params.message || '§c狂骨！！！') : '§c狂骨：回血失败');
            }
            return true;
        },
    },

    // ------------------------------------------------------------ 斩杀（目标残血才生效）
    {
        id: 'cleave',
        name: '斩绝',
        alias: ['斩绝', '斩杀', 'cleave', 'execute'],
        slot: 'weapon',
        maxLevel: 34,
        trigger: 'hit',
        /**
         * 1 级 3%，每级 +3%：3 / 6 / 9 / … / 99 / 100
         * 99% 是第 33 级，100% 是第 34 级 → 上限 34
         */
        chance: stepsUpTo100(3),
        params: { healthRatio: 0.3, announce: true, message: '§4斩绝！！！' },
        desc: '目标生命 ≤30% 时，命中概率直接斩杀（1 级 3%，每级 +3%，满级 100%）',
        run(ctx) {
            const max = Number(ctx.target && ctx.target.maxHealth);
            const hp = Number(ctx.target && ctx.target.health);
            if (!isFinite(max) || max <= 0 || !isFinite(hp)) return null;

            const ratio = isFinite(Number(ctx.params.healthRatio)) ? Number(ctx.params.healthRatio) : 0.3;
            if (hp > max * ratio) return null;       // 目标还健康 → 不斩杀

            const ok = ctx.killTarget();
            if (ctx.params.announce === true) {
                ctx.say(ok ? String(ctx.params.message || '§4斩绝！！！') : '§c斩绝：斩杀失败');
            }
            return true;
        },
    },

    // ------------------------------------------------------------ 爆炸（不破坏地形）
    {
        id: 'blast',
        name: '爆破',
        alias: ['爆破', '爆炸', 'blast', 'explosion'],
        slot: 'weapon',
        maxLevel: 20,
        trigger: 'hit',
        // 1 级 5%，每级 +5%：5 / 10 / … / 100（20 级满）
        chance: stepsUpTo100(5),
        /**
         * radius   爆炸半径
         * damage   仅当原生爆炸不可用时，自己算伤害的中心值（按距离衰减）
         * native   是否优先用原生 mc.explode（**默认 true**：要原版特效和击退）
         * destroy  是否破坏方块 —— 默认 false；改成 true 就会炸地形，慎用
         */
        params: { radius: 4, damage: 8, native: true, destroy: false, fire: false, announce: false, message: '§6爆破！！！' },
        desc: '命中时概率在目标位置引发爆炸（原版特效与击退，不破坏方块）',
        run(ctx) {
            const radius = isFinite(Number(ctx.params.radius)) ? Number(ctx.params.radius) : 4;
            const damage = isFinite(Number(ctx.params.damage)) ? Number(ctx.params.damage) : 8;
            const destroy = ctx.params.destroy === true;

            // 1) 先试原生爆炸（原版特效 + 击退，包括自己）
            let nativeOk = false;
            if (ctx.params.native !== false) {
                nativeOk = ctx.explodeAt(radius, destroy, ctx.params.fire === true) === true;
            }

            // 2) 原生没生效 → 自己算伤害兜底（包括自己，带尽力击退）
            let manualHits = 0;
            if (!nativeOk) manualHits = ctx.blastAt(radius, damage);

            if (ctx.params.announce === true) {
                ctx.say(String(ctx.params.message || '§6爆破！！！')
                    + (nativeOk ? ' §7(原生爆炸)' : (manualHits > 0 ? ' §7(兜底伤害，波及 ' + manualHits + ' 个)' : ' §7(附近没有目标)')));
            }
            return true;
        },
    },

    // ------------------------------------------------------------ 混沌（随机 / 全部）
    {
        id: 'chaos',
        name: '混沌打击',
        alias: ['混沌打击', '混沌', 'chaos'],
        slot: 'weapon',
        maxLevel: 10,
        trigger: 'hit',
        chance: TEN_STEPS.slice(),          // 和淬毒一样：10% 起，每级 +10%
        params: { announce: false, message: '§5混沌打击！！！' },
        desc: '命中时概率随机触发一个词条（雷神/死亡/侵袭/饥荒/冰冻/飞升/掠袭 里随机）',
        run(ctx) {
            const r = (typeof ctx.rng === 'function') ? ctx.rng() : Math.random();
            let idx = Math.floor(r * CHAOS_POOL.length);
            if (!(idx >= 0) || idx >= CHAOS_POOL.length) idx = 0;
            const picked = CHAOS_POOL[idx];

            runSubEffects(ctx, [picked]);

            if (ctx.params.announce === true) {
                const def = BY_ID.get(picked);
                ctx.say(String(ctx.params.message || '§5混沌打击！！！')
                    + ' §7→ §b' + (def != null ? def.name : picked));
            }
            return true;
        },
    },
    {
        id: 'chaos_total',
        name: '完全混沌',
        alias: ['完全混沌', '混沌全能', 'totalchaos'],
        slot: 'weapon',
        maxLevel: 10,
        trigger: 'hit',
        chance: TEN_STEPS.slice(),
        params: { announce: false, message: '§5完全混沌！！！' },
        desc: '命中时概率同时触发全部词条（雷神+死亡+侵袭+饥荒+冰冻+飞升+掠袭 全来一遍）',
        run(ctx) {
            const n = runSubEffects(ctx, CHAOS_POOL);

            if (ctx.params.announce === true) {
                ctx.say(String(ctx.params.message || '§5完全混沌！！！')
                    + ' §7（同时触发 ' + n + ' 个效果）');
            }
            return true;
        },
    },

    // ------------------------------------------------------------ 护甲「领域」系列
    // 受到伤害时，概率把对应效果打到**攻击者**身上。
    // 概率/强度/时长与武器上的同名词条一致（同一个工厂、同一套参数）。
    {
        id: 'aura_thunder',
        name: '雷之领域',
        alias: ['雷之领域', 'aurathunder'],
        slot: 'armor',                 // 四件套 / 鞘翅 / 头颅都算
        maxLevel: 10,
        trigger: 'hurt',               // 自己挨打时判定
        chance: TEN_STEPS.slice(),
        params: { announce: false, message: '§e雷之领域！！！' },
        desc: '受伤时概率在攻击者位置召唤闪电',
        run(ctx) {
            const pos = ctx.targetPos();   // target = 攻击者
            if (pos == null) return 'no-pos';
            const ok = ctx.lightningAt(pos, ctx.targetDim(), ctx.params.mode);
            if (ctx.params.announce === true) {
                ctx.say(ok === false ? '§c雷之领域：召唤闪电失败'
                    : String(ctx.params.message || '§e雷之领域！！！'));
            }
            return true;
        },
    },
    makeOnHitEffect({
        id: 'aura_wither', name: '死亡领域', alias: ['死亡领域', 'aurawither'],
        slot: 'armor', trigger: 'hurt', effect: FX.WITHER,
        desc: '受伤时概率让攻击者凋零 3 秒（等级越高越强）',
        say: '§8死亡领域！！！',
    }),
    makeOnHitEffect({
        id: 'aura_blind', name: '侵袭之域', alias: ['侵袭之域', 'aurablind'],
        slot: 'armor', trigger: 'hurt', effect: FX.BLINDNESS,
        desc: '受伤时概率让攻击者失明 3 秒（等级越高越强）',
        say: '§7侵袭之域！！！',
    }),
    makeOnHitEffect({
        id: 'aura_famine', name: '荒芜领域', alias: ['荒芜领域', 'aurafamine'],
        slot: 'armor', trigger: 'hurt', effect: FX.HUNGER,
        fixedAmplifier: 254,           // 和武器「饥荒」一致：固定显示 255 级
        desc: '受伤时概率让攻击者饥饿 3 秒（强度固定 255，不随等级变化）',
        say: '§6荒芜领域！！！',
    }),
    makeOnHitEffect({
        id: 'aura_chill', name: '寒冰领域', alias: ['寒冰领域', 'aurachill'],
        slot: 'armor', trigger: 'hurt', effect: FX.SLOWNESS,
        desc: '受伤时概率让攻击者缓慢 3 秒（等级越高越强）',
        say: '§b寒冰领域！！！',
    }),
    makeOnHitEffect({
        id: 'aura_ascend', name: '苍空领域', alias: ['苍空领域', 'auraascend'],
        slot: 'armor', trigger: 'hurt', effect: FX.LEVITATION,
        desc: '受伤时概率让攻击者漂浮 3 秒（等级越高越强）',
        say: '§d苍空领域！！！',
    }),
    makeOnHitEffect({
        id: 'aura_raid', name: '掠袭领域', alias: ['掠袭领域', 'auraraid'],
        slot: 'armor', trigger: 'hurt', effect: FX.DARKNESS,
        desc: '受伤时概率让攻击者陷入黑暗 3 秒（等级越高越强）',
        say: '§5掠袭领域！！！',
    }),
    {
        id: 'aura_chaos',
        name: '混沌领域',
        alias: ['混沌领域', 'aurachaos'],
        slot: 'armor',
        maxLevel: 10,
        trigger: 'hurt',
        chance: TEN_STEPS.slice(),
        params: { announce: false, message: '§5混沌领域！！！' },
        desc: '受伤时概率把 7 个领域效果里的**一个**随机打到攻击者身上',
        run(ctx) {
            const r = (typeof ctx.rng === 'function') ? ctx.rng() : Math.random();
            let idx = Math.floor(r * CHAOS_POOL.length);
            if (!(idx >= 0) || idx >= CHAOS_POOL.length) idx = 0;
            const picked = CHAOS_POOL[idx];

            runSubEffects(ctx, [picked]);

            if (ctx.params.announce === true) {
                const def = BY_ID.get(picked);
                ctx.say(String(ctx.params.message || '§5混沌领域！！！')
                    + ' §7→ §b' + (def != null ? def.name : picked));
            }
            return true;
        },
    },
    {
        id: 'aura_chaos_total',
        name: '终焉混沌',
        alias: ['终焉混沌', 'aurachaostotal'],
        slot: 'armor',
        maxLevel: 10,
        trigger: 'hurt',
        chance: TEN_STEPS.slice(),
        params: { announce: false, message: '§5终焉混沌！！！' },
        desc: '受伤时概率把 7 个领域效果**全部**打到攻击者身上',
        run(ctx) {
            const n = runSubEffects(ctx, CHAOS_POOL);

            if (ctx.params.announce === true) {
                ctx.say(String(ctx.params.message || '§5终焉混沌！！！')
                    + ' §7（同时触发 ' + n + ' 个效果）');
            }
            return true;
        },
    },
];

// -------------------------------------------------------------- 索引
const BY_ID = new Map();
const BY_KEY = new Map();

for (const e of ENCHANTS) {
    BY_ID.set(e.id, e);
    BY_KEY.set(String(e.name).toLowerCase(), e);
    for (const a of e.alias || []) {
        const k = String(a).toLowerCase();
        if (!BY_KEY.has(k)) BY_KEY.set(k, e);
    }
}

/** 关键词按长度倒序：先匹配长名字 */
const KEYS = Array.from(BY_KEY.keys()).sort((a, b) => b.length - a.length);

const Enchants = {
    LIST: ENCHANTS,
    KEYS: KEYS,
    FX: FX,
    byKey(key) {
        if (key == null) return null;
        return BY_KEY.get(String(key).trim().toLowerCase()) || null;
    },
    byId(id) {
        return BY_ID.get(String(id)) || null;
    },
    nameOf(id) {
        const e = BY_ID.get(String(id));
        return e ? e.name : String(id);
    },
    chanceOf(enchant, level) {
        const arr = enchant && Array.isArray(enchant.chance) ? enchant.chance : [];
        if (arr.length === 0) return 0;
        if (enchant.trigger === 'tick') return 100;
        return byLevel(arr, level);
    },
    label(enchant, level) {
        return enchant.name + roman(level);
    },
    /** 有常驻（轮询）词条吗？没有就不用起定时器 */
    hasPassive() {
        for (const e of ENCHANTS) if (e.trigger === 'tick') return true;
        return false;
    },
};

exports.Enchants = Enchants;
exports.FX = FX;
exports.TEN_STEPS = TEN_STEPS;
exports.makeOnHitEffect = makeOnHitEffect;
