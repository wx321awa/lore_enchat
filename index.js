"use strict";
/**
 * lore_enchant —— **雷神单测版**（v0.2.0）
 *
 * 只保留「雷神」一个词条，用来确认整条链路：
 *
 *     lore 写成「雷神III」 → 手持武器命中 → 概率判定 → 在目标位置召唤闪电
 *
 * 和上一版的区别（这是重点）：
 *   近战命中改成监听 **onAttackEntity(attacker, victim)**，不再依赖 onMobHurt 的
 *   第 2 个参数。线上日志证明：onAttackEntity 一定给到玩家对象，而某些 LSE 版本的
 *   onMobHurt 传进来的 source 不是玩家对象（has getHand == false），导致近战分支永远
 *   不成立 —— 表现就是「第一次靠兜底触发了，之后就再也不触发」。
 *
 * onMobHurt 用来跑**护甲/领域类**词条（只看「被打的是不是玩家」），
 * 近战则走 onAttackEntity —— 因为某些 LSE 版本的 onMobHurt 传进来的 source
 * 不是玩家对象（hasGetHand == false），靠它识别攻击者会永远失败。
 *
 * 命令：
 *      /le              看手持物品解析出什么词条 + 最近判定
 *      /le list         词条表
 *      /le diag         OP：解析 / 判定过程 / 统计
 *      /le reload       OP：重载配置
 *      /le test 雷神     OP：看各等级概率
 */
const { Config } = require("plugins/lore_enchant/src/config");
const { Runtime } = require("plugins/lore_enchant/src/runtime");
const { Enchants } = require("plugins/lore_enchant/src/enchants");
const gear = require("plugins/lore_enchant/src/gear");
const loreedit = require("plugins/lore_enchant/src/loreedit");
const { roman, byLevel, slotMatches, fmtPos } = require("plugins/lore_enchant/src/util");

const VERSION = [1, 8, 5];
const BRAND = 'XiYing定制版';

try {
    ll.registerPlugin('lore_enchant', '按物品Lore触发战斗词条（' + BRAND + ' · 雷神单测版）', VERSION, {
        author: 'xxhh.',
        License: 'Apache-2.0',
    });
} catch (e) {
    log('[lore_enchant] ll.registerPlugin 跳过: ' + e);
}

// 顶层先加载配置：热重载后不会重发 onServerStarted
Config.load();

const rt = new Runtime();

const isOP = (p) => {
    try {
        return p != null && typeof p.isOP === 'function' && p.isOP() === true;
    } catch (e) {
        return false;
    }
};

const sendLines = (output, text) => {
    const lines = String(text == null ? '' : text).split('\n');
    for (let i = 0; i < lines.length; i++) output.success(lines[i]);
};

// ------------------------------------------------------------------ 命令
// 第一参数故意用 String 而不是 Enum：
//   子命令（list/diag/reload/test）和「词条名」（雷神/thunder）要能共存，
//   这样才能写 `/le 雷神 3` 直接给手持物品附词条。
/** 命令第一参数的可选值：子命令 + 所有词条的「中文名 / 英文 id」。
 *  用 Enum 而不是自由文本，BDS 才会给 Tab 补全。 */
function commandKeywords() {
    const kw = ['status', 'list', 'diag', 'reload', 'test', 'gui', 'api', 'clear', 'cmdtest'];
    for (let i = 0; i < Enchants.LIST.length; i++) {
        kw.push(Enchants.LIST[i].name);
        kw.push(Enchants.LIST[i].id);
    }
    return kw;
}

try {
    const cmd = mc.newCommand('le', 'Lore战斗词条 ' + BRAND + ' —— /le 看状态；/le 雷神 3 附魔；/le gui 图形界面', PermType.Any);
    cmd.setEnum('e_le', commandKeywords());
    cmd.optional('pfx', ParamType.Enum, 'e_le');
    cmd.optional('level', ParamType.Int);
    // 参数标识符用枚举名，Tab 才会按枚举补全；空重载 = 直接 /le
    try { cmd.overload([]); } catch (e0) { }
    try { cmd.overload(['e_le']); } catch (e1) { }
    try { cmd.overload(['e_le', 'level']); } catch (e2) { }
    cmd.setCallback((_cmd, origin, output, res) => {
        const player = origin.player;
        const action = (res.pfx == null) ? 'status' : String(res.pfx).trim();
        const levelArg = (res.level == null) ? null : Number(res.level);

        if (action === 'status' || action === '') {
            if (player == null) {
                output.error('/le 需要在游戏里由玩家执行');
                return;
            }
            sendLines(output, statusLines(player));
            return;
        }

        if (action === 'reload') {
            if (player != null && !isOP(player)) {
                output.error('只有 OP 能重载配置');
                return;
            }
            rt.restart();
            output.success('配置已重载，解析缓存已清空');
            return;
        }

        if (action === 'list') {
            output.success('§l§d词条表（lore 里写「名字+等级」，中文名或英文 id 都认）');
            const lines = statusListLines();
            for (let i = 0; i < lines.length; i++) output.success(lines[i]);
            return;
        }

        if (action === 'test') {
            if (player == null) {
                output.error('需要在游戏里执行');
                return;
            }
            if (!isOP(player)) {
                output.error('只有 OP 能查');
                return;
            }
            sendLines(output, testLines(null));
            return;
        }

        if (action === 'diag') {
            if (player == null) {
                output.error('需要在游戏里执行');
                return;
            }
            if (!isOP(player)) {
                output.error('只有 OP 能做诊断');
                return;
            }
            sendLines(output, diagLines(player));
            return;
        }

        if (action === 'gui') {
            openGui(player, output);
            return;
        }

        if (action === 'clear') {
            if (player == null) {
                output.error('需要在游戏里执行');
                return;
            }
            if (!isOP(player)) {
                output.error('只有 OP 能清除词条');
                return;
            }
            const r = loreedit.clearAllEnchants(player);
            if (r.ok) {
                output.success('已清除 §e' + r.removed + '§r 个词条（保留了 ' + r.kept + ' 行其它 lore）');
            } else {
                output.error(r.msg);
            }
            return;
        }

        if (action === 'cmdtest') {
            if (player == null) {
                output.error('需要在游戏里执行');
                return;
            }
            if (!isOP(player)) {
                output.error('只有 OP 能做命令测试');
                return;
            }
            sendLines(output, cmdTestLines(player));
            return;
        }

        if (action === 'api') {
            if (player == null) {
                output.error('需要在游戏里执行');
                return;
            }
            sendLines(output, apiLines(player));
            return;
        }

        // 不是子命令 → 当成「快捷附魔」：/le 雷神 3
        enchantHeld(player, action, levelArg, output);
    });
    cmd.setup();
} catch (e) {
    log('[lore_enchant] 命令注册失败: ' + e);
}

// 单独的 /legui（和 /le gui 等价）
try {
    const gc = mc.newCommand('legui', 'Lore战斗词条 GUI 版：给手持物品附词条', PermType.Any);
    try { gc.overload([]); } catch (e0) { }
    gc.setCallback((_cmd, origin, output) => {
        openGui(origin.player, output);
    });
    gc.setup();
} catch (e) {
    log('[lore_enchant] /legui 注册失败: ' + e);
}

/**
 * 给手持物品打上词条 lore：/le 雷神 3
 * 真正的读写都在 loreedit.applyToHeld 里（容器 setItem + refreshItems + 读回校验）。
 */
function enchantHeld(player, nameArg, levelArg, output) {
    if (player == null) {
        output.error('这个用法需要在游戏里执行（/le 雷神 3）');
        return;
    }
    if (!isOP(player)) {
        output.error('只有 OP 能给物品附词条');
        return;
    }
    const def = Enchants.byKey(nameArg) || Enchants.byId(nameArg);
    if (def == null) {
        output.error('没有这个词条：' + nameArg + '（/le list 看词条表）');
        return;
    }
    const loc = loreedit.readHeld(player);
    if (loc == null) {
        output.error('请先手持要附魔的物品');
        return;
    }
    if (!slotMatches(loc.item.type, def.slot)) {
        output.error('「' + def.name + '」只能用在「' + slotLabel(def.slot) + '」上，你拿的是 ' + String(loc.item.type));
        return;
    }

    let lv = (levelArg == null || !isFinite(levelArg)) ? 1 : Math.floor(levelArg);
    const capped = lv > def.maxLevel;
    lv = Math.max(1, Math.min(def.maxLevel, lv));

    const r = loreedit.applyToHeld(player, def, lv);
    if (r.ok) {
        output.success('已给手持物品附上 §b' + Enchants.label(def, lv) + '§r'
            + (capped ? '（超过上限，已按 ' + def.maxLevel + ' 级处理）' : '')
            + '，lore 现在 ' + r.lines + ' 行 §8[' + r.via + ' → ' + (r.paths || []).join('/') + ']');
    } else {
        output.error('附魔失败：' + r.msg + '（试过: ' + (r.paths || []).join(' / ') + '）');
    }
}

// ------------------------------------------------------------------ GUI 版
/** 表单相关 API 是否齐全（缺哪个直接说，别等回调里炸成 "not a function"） */
function formApiProblem() {
    if (typeof mc === 'undefined' || mc == null) return 'mc 不存在';
    if (typeof mc.newSimpleForm !== 'function') return 'mc.newSimpleForm 不是函数';
    if (typeof mc.newCustomForm !== 'function') return 'mc.newCustomForm 不是函数';
    return null;
}

/** 词条归类：武器类 / 护甲类（按 slot 判断，加新词条自动归位） */
function categoryOf(slot) {
    const s = String(slot == null ? '' : slot).toLowerCase();
    if (s === 'armor' || s === 'helmet' || s === 'chest' || s === 'legs' || s === 'boots') return 'armor';
    return 'weapon';
}

function enchantsOfCategory(cat) {
    const out = [];
    for (let i = 0; i < Enchants.LIST.length; i++) {
        if (categoryOf(Enchants.LIST[i].slot) === cat) out.push(Enchants.LIST[i]);
    }
    return out;
}

/** /le gui 或 /legui：主菜单 → 武器 / 护甲 → 词条 → 等级 */
function openGui(player, output) {
    if (player == null) {
        if (output != null) output.error('需要在游戏里执行');
        return;
    }
    const err = (m) => {
        try {
            if (output != null && typeof output.error === 'function') output.error(m);
            else if (typeof player.tell === 'function') player.tell(m);
        } catch (e) { }
    };
    if (!isOP(player)) {
        err('§c只有 OP 能使用快捷附魔');
        return;
    }

    const bad = formApiProblem();
    if (bad != null) {
        err('§c表单 API 不可用（' + bad + '），请改用 /le 雷神 7');
        return;
    }
    if (typeof player.sendForm !== 'function') {
        err('§cplayer.sendForm 不是函数，请改用 /le 雷神 7');
        return;
    }

    const weaponCount = enchantsOfCategory('weapon').length;
    const armorCount = enchantsOfCategory('armor').length;

    let fm = null;
    try {
        fm = mc.newSimpleForm();
    } catch (e) {
        err('§cmc.newSimpleForm() 抛错：' + e);
        return;
    }
    if (fm == null || typeof fm.addButton !== 'function') {
        err('§cmc.newSimpleForm() 返回的对象没有 addButton');
        return;
    }

    try {
        if (typeof fm.setTitle === 'function') fm.setTitle('§l§b快捷附魔');
        if (typeof fm.setContent === 'function') {
            fm.setContent('§7版本 v' + VERSION.join('.') + ' · 共 §e' + Enchants.LIST.length + ' §7个词条'
                + '\n§7先选分类，再选词条和等级');
        }
        fm.addButton('§b武器附魔 §8(' + weaponCount + ' 个)');
        fm.addButton('§d护甲附魔 §8(' + armorCount + ' 个)');
        fm.addButton('§c一键清除词条');
    } catch (e) {
        err('§c构造主菜单失败：' + e);
        return;
    }

    player.sendForm(fm, (pl, id) => {
        const who = (pl != null && typeof pl.sendForm === 'function') ? pl : player;
        try {
            if (id == null || id < 0) return;                 // 取消
            if (id === 0) openCategory(who, 'weapon');
            else if (id === 1) openCategory(who, 'armor');
            else if (id === 2) openClearConfirm(who);
        } catch (e) {
            log('[lore_enchant] 主菜单回调出错: ' + e);
        }
    });
}

/** 一键清除：确认页（列出将要移除的词条，点确认才动手） */
function openClearConfirm(player) {
    if (player == null) return;
    const tell = (m) => { try { if (typeof player.tell === 'function') player.tell(m); } catch (e) { } };

    const loc = loreedit.readHeld(player);
    if (loc == null) {
        tell('§c请先手持要清除的物品');
        return;
    }
    const cfg = Config.get();
    const found = gear.enchantsOf(loc.item, cfg);
    if (found.size === 0) {
        tell('§e这件物品上没有本插件的词条');
        return;
    }

    const names = [];
    for (const [id, lv] of found) names.push(Enchants.nameOf(id) + roman(lv));

    let fm = null;
    try {
        fm = mc.newSimpleForm();
    } catch (e) {
        tell('§c建表单失败：' + e);
        return;
    }
    if (fm == null || typeof fm.addButton !== 'function') return;

    try {
        if (typeof fm.setTitle === 'function') fm.setTitle('§l§c一键清除词条');
        if (typeof fm.setContent === 'function') {
            fm.setContent('§7物品：§f' + String(loc.item.name || loc.item.type)
                + '\n§7将移除 §c' + names.length + ' §7个词条：§c' + names.join('§7、§c')
                + '\n§8其它 lore 行会保留，不可撤销');
        }
        fm.addButton('§c确认清除');
        fm.addButton('§7取消');
    } catch (e) {
        tell('§c构造清除表单失败：' + e);
        return;
    }

    player.sendForm(fm, (pl, id) => {
        const who = (pl != null && typeof pl.sendForm === 'function') ? pl : player;
        if (id !== 0) return;                                  // 只有第一个按钮才动手
        const r = loreedit.clearAllEnchants(who);
        if (r.ok) who.tell('§a已清除 §e' + r.removed + ' §a个词条（保留了 ' + r.kept + ' 行其它 lore）');
        else who.tell('§c清除失败：' + r.msg);
    });
}

/** 某个分类下的词条列表 */
function openCategory(player, cat) {
    const isArmor = (cat === 'armor');
    const title = isArmor ? '§l§d护甲附魔' : '§l§b武器附魔';

    const list = enchantsOfCategory(cat);
    if (list.length === 0) {
        try { player.tell('§e这个分类还没有词条' + (isArmor ? '（护甲词条还没做）' : '')); } catch (e) { }
        return;
    }

    const loc = loreedit.readHeld(player);
    const item = (loc != null) ? loc.item : null;

    let fm = null;
    try {
        fm = mc.newSimpleForm();
    } catch (e) {
        try { player.tell('§c建表单失败：' + e); } catch (e2) { }
        return;
    }
    if (fm == null || typeof fm.addButton !== 'function') return;

    try {
        if (typeof fm.setTitle === 'function') fm.setTitle(title);
        if (typeof fm.setContent === 'function') {
            fm.setContent(item == null
                ? '§7没有手持物品（点了会提示你先拿一件）'
                : '§7手持：§f' + String(item.name || item.type) + ' §8(' + String(item.type) + ')'
                    + '\n§7共 ' + list.length + ' 个词条');
        }
    } catch (e) { }

    const usable = [];
    for (let i = 0; i < list.length; i++) {
        const def = list[i];
        usable.push(def);
        let ok = false;
        try { ok = item != null && slotMatches(item.type, def.slot); } catch (e) { ok = false; }
        try {
            fm.addButton('§b' + def.name + ' §8(' + slotLabel(def.slot) + '，最高 ' + def.maxLevel + ' 级)'
                + (item != null && !ok ? ' §8· 不适用当前手持' : ''));
        } catch (e) {
            try { player.tell('§caddButton 失败：' + e); } catch (e2) { }
            return;
        }
    }

    player.sendForm(fm, (pl, id) => {
        const who = (pl != null && typeof pl.sendForm === 'function') ? pl : player;
        try {
            if (id == null || id < 0) return;
            const def = usable[id];
            if (def == null) return;

            // 点的时候重新读一次手持物品（可能已经换了）
            const now = loreedit.readHeld(who);
            if (now == null) {
                who.tell('§c请先手持要附魔的物品');
                return;
            }
            if (!slotMatches(now.item.type, def.slot)) {
                who.tell('§c「' + def.name + '」只能用在「' + slotLabel(def.slot) + '」上，你拿的是 ' + String(now.item.type));
                return;
            }
            openLevelForm(who, def);
        } catch (e) {
            log('[lore_enchant] 分类表单回调出错: ' + e);
        }
    });
}

function openLevelForm(player, def) {
    const bad = formApiProblem();
    if (bad != null) {
        try { player.tell('§c表单 API 不可用（' + bad + '），请改用 /le ' + def.name + ' ' + def.maxLevel); } catch (e) { }
        return;
    }

    let fm = null;
    try {
        fm = mc.newCustomForm();
    } catch (e) {
        try { player.tell('§cmc.newCustomForm() 抛错：' + e); } catch (e2) { }
        return;
    }
    if (fm == null || typeof fm.addSlider !== 'function') {
        try { player.tell('§c这个版本的自定义表单没有 addSlider，请用 /le ' + def.name + ' <等级>'); } catch (e) { }
        return;
    }

    try {
        if (typeof fm.setTitle === 'function') fm.setTitle('§l§b附魔 · ' + def.name);
        if (typeof fm.setContent === 'function') fm.setContent('§7' + def.desc);
        fm.addSlider('§e等级（1 ~ ' + def.maxLevel + '）', 1, def.maxLevel, 1, def.maxLevel);
    } catch (e) {
        log('[lore_enchant] 构造等级表单失败: ' + e);
        return;
    }

    player.sendForm(fm, (pl, data) => {
        const who = (pl != null && typeof pl.tell === 'function') ? pl : player;
        try {
            if (data == null) return;                         // 取消
            let lv = 1;
            try { lv = Math.floor(Number(data[0])); } catch (e) { lv = 1; }
            if (!isFinite(lv)) lv = 1;
            lv = Math.max(1, Math.min(def.maxLevel, lv));

            const r = loreedit.applyToHeld(who, def, lv);
            if (r.ok) {
                who.tell('§a已给手持物品附上 ' + Enchants.label(def, lv) + '§a（lore ' + r.lines + ' 行）');
            } else {
                who.tell('§c附魔失败：' + r.msg + '（试过 ' + (r.paths || []).join('/') + '）');
            }
        } catch (e) {
            log('[lore_enchant] 等级表单回调出错: ' + e);
        }
    });
}

/** /le cmdtest：在你脚下 summon 一道闪电，把 BDS 的原始返回打出来（排「召唤失败」用） */
function cmdTestLines(player) {
    const out = [];
    const pos = fmtPos(player.pos);
    out.push('§l§e命令测试 §8v' + VERSION.join('.'));
    out.push('§7你的坐标：' + pos);
    if (pos == null) {
        out.push('§c拿不到坐标（player.pos 不可用）');
        return out.join('\n');
    }
    const cmd = 'summon lightning_bolt ' + pos;
    out.push('§7命令：§f' + cmd);

    if (typeof mc.runcmdEx === 'function') {
        try {
            const res = mc.runcmdEx(cmd);
            out.push('§7runcmdEx → §f' + JSON.stringify(res));
        } catch (e) {
            out.push('§cruncmdEx 抛错：' + e);
        }
    } else {
        out.push('§7没有 mc.runcmdEx');
    }

    if (typeof mc.runcmd === 'function') {
        try {
            const r2 = mc.runcmd(cmd);
            out.push('§7runcmd → §f' + String(r2));
        } catch (e) {
            out.push('§cruncmd 抛错：' + e);
        }
    } else {
        out.push('§7没有 mc.runcmd');
    }

    out.push('§8把这几行发给作者就能定位');
    return out.join('\n');
}

/** /le api：把用到的关键 API 的 typeof 全部打出来（排障用） */
function apiLines(player) {
    const out = [];
    const t = (v) => (v == null ? 'null' : typeof v);
    out.push('§l§eAPI 检查 §8v' + VERSION.join('.'));
    out.push('§7mc.simpleForm   = ' + t(mc.newSimpleForm) + ' / customForm = ' + t(mc.newCustomForm));
    out.push('§7mc.runcmd       = ' + t(mc.runcmd) + ' / runcmdEx = ' + t(mc.runcmdEx));
    out.push('§7mc.explode      = ' + t(mc.explode) + ' / getEntities = ' + t(mc.getEntities));
    if (player != null) {
        out.push('§7player.sendForm = ' + t(player.sendForm) + ' / refreshItems = ' + t(player.refreshItems));
        out.push('§7player.getHand  = ' + t(player.getHand) + ' / getInventory = ' + t(player.getInventory));
        out.push('§7selectedSlot    = ' + player.selectedSlot + ' / selectedItemSlot = ' + player.selectedItemSlot);
        const loc = loreedit.readHeld(player);
        if (loc != null) {
            out.push('§7手持来源        = ' + loc.via + '（槽位 ' + loc.slot + '）');
            out.push('§7item.setLore    = ' + t(loc.item.setLore) + ' / item.lore = ' + t(loc.item.lore));
            out.push('§7item.getNbt     = ' + t(loc.item.getNbt));
        }
    }
    return out.join('\n');
}

// -------------------------------------------------------------- 输出辅助
function statusListLines() {
    const out = [];
    for (const e of Enchants.LIST) {
        const one = Config.forEnchant(e.id);
        const parts = [];
        for (let lv = 1; lv <= e.maxLevel; lv++) parts.push(roman(lv) + ' ' + byLevel(one.chance, lv) + '%');
        out.push('§b' + e.name + ' §8[' + e.id + '] §7[' + slotLabel(e.slot) + '] §f' + parts.join(' / ')
            + (one.enabled === false ? ' §c(已禁用)' : ''));
        out.push('§8    ' + e.desc);
    }
    return out;
}

function slotLabel(slot) {
    const map = {
        weapon: '武器', sword: '剑', axe: '斧', bow: '弓', pickaxe: '镐',
        armor: '任意护甲', helmet: '头盔', chest: '胸甲', legs: '护腿', boots: '靴子',
        hand: '手持', any: '任意',
    };
    return map[slot] || slot;
}

function statusLines(player) {
    const cfg = Config.get();
    const out = [];
    out.push('§l§bLore 战斗词条 §7' + BRAND + ' v' + VERSION.join('.')
        + ' §8· ' + Enchants.LIST.length + ' 个词条');
    if (cfg.enabled === false) out.push('§c总开关已关闭（config.enabled = false）');
    if (cfg.require_marker) out.push('§7只解析含「' + cfg.require_marker + '」的行');

    const item = gear.handItem(player);
    if (item == null) {
        out.push('§7主手没有物品');
    } else {
        const lines = gear.readLore(item);
        const enchants = gear.enchantsOf(item, cfg);
        out.push('§f主手：§e' + String(item.name || item.type) + ' §8(' + String(item.type) + ')');
        out.push('§8  读到 ' + lines.length + ' 行 lore'
            + (lines.length > 0 ? '，首行 §7' + String(lines[0]).slice(0, 32) : ' §c（读不到 lore！）'));
        if (enchants.size === 0) {
            out.push('§8没解析到词条：要写「雷神III」「雷神3」「雷神 等级3」这种（必须带等级）'
                + (cfg.require_marker ? '，且该行要含「' + cfg.require_marker + '」' : ''));
        } else {
            for (const [id, lv] of enchants) {
                const def = Enchants.byId(id);
                const ok = def != null && slotMatches(item.type, def.slot);
                const one = Config.forEnchant(id);
                const chance = (one.chance && one.chance.length > 0) ? byLevel(one.chance, lv) : 100;
                out.push('§8  - §b' + Enchants.label(def, lv)
                    + ' §7' + (ok ? '' : '§c(不适用于该物品) ') + '§f' + chance + '%');
            }
        }
    }
    out.push('§7统计 ' + JSON.stringify(rt.stats));
    if (rt.lastDecisions.length > 0) {
        out.push('§7最近判定：§8' + rt.lastDecisions[rt.lastDecisions.length - 1]);
        out.push('§8  完整过程用 /le diag 看');
    }
    return out.join('\n');
}

function diagLines(player) {
    const cfg = Config.get();
    const out = [];
    out.push('§l§e诊断 §8v' + VERSION.join('.') + '（雷神单测版）');
    out.push('§7enabled=' + cfg.enabled + ' require_level=' + cfg.require_level
        + ' marker=' + JSON.stringify(cfg.require_marker));
    out.push('§7词条数=' + Enchants.LIST.length + ' 关键词数=' + Enchants.KEYS.length);
    const items = gear.collect(player, cfg);
    for (const one of items) {
        const arr = [];
        for (const [id, lv] of one.enchants) arr.push(Enchants.nameOf(id) + roman(lv));
        out.push('§7' + one.where + ' §f' + String((one.item && (one.item.name || one.item.type)) || '-')
            + ' §8→ ' + (arr.length ? arr.join(' / ') : '无'));
    }
    out.push('§7统计 ' + JSON.stringify(rt.stats));
    out.push('§7冷却 ' + rt.cooldowns.size + ' 条');
    out.push('§e--- 最近判定过程 ---');
    if (rt.lastDecisions.length === 0) {
        out.push('§8（还没有记录：拿着带「雷神III」的武器打一下怪）');
    } else {
        for (let i = 0; i < rt.lastDecisions.length; i++) out.push('§8· ' + rt.lastDecisions[i]);
    }
    return out.join('\n');
}

function testLines(arg) {
    const key = arg == null ? '' : String(arg).trim();

    // 不给参数 → 列出所有词条各等级概率（现在只有一个词条，够用）
    if (key.length === 0) {
        const lines = [];
        for (let i = 0; i < Enchants.LIST.length; i++) {
            const def = Enchants.LIST[i];
            lines.push(singleEnchantInfo(def));
        }
        if (lines.length === 0) return '§c没有可用的词条';
        lines.push('§7想看单个：/le test 雷神');
        return lines.join('\n');
    }

    const def = Enchants.byKey(key) || Enchants.byId(key);
    if (def == null) return '§c没有这个词条：' + key;
    return singleEnchantInfo(def);
}

function singleEnchantInfo(def) {
    const one = Config.forEnchant(def.id);
    const parts = [];
    for (let lv = 1; lv <= def.maxLevel; lv++) {
        const chance = (one.chance && one.chance.length > 0) ? byLevel(one.chance, lv) : 100;
        parts.push(roman(lv) + '=' + chance + '%');
    }
    return '§b' + def.name + ' §8[' + def.id + '] [' + slotLabel(def.slot) + ']\n'
        + '§7概率：§f' + parts.join(' / ') + '\n'
        + '§7' + def.desc + '\n'
        + '§7当前配置：' + (one.enabled === false ? '§c已禁用' : '§a启用') + ' 冷却 ' + one.cooldown_ms + 'ms';
}

// ------------------------------------------------------------ 事件和轮询
function safeListen(event, cb) {
    try {
        mc.listen(event, cb);
        return true;
    } catch (e) {
        log('[lore_enchant] 监听 ' + event + ' 失败: ' + e);
        return false;
    }
}

/** 打印一个值是什么（诊断 onMobHurt 参数用） */
function desc(v) {
    if (v == null) return 'null';
    if (typeof v !== 'object') return typeof v + '(' + String(v).slice(0, 20) + ')';
    const bits = [];
    try { if (v.type != null) bits.push('type=' + v.type); } catch (e) { }
    try { bits.push('isPlayer=' + (typeof v.isPlayer === 'function' ? v.isPlayer() : v.isPlayer)); } catch (e) { bits.push('isPlayer=?'); }
    try { bits.push('hasGetHand=' + (typeof v.getHand === 'function')); } catch (e) { }
    try { if (v.id != null) bits.push('id=' + v.id); } catch (e) { }
    return '{' + bits.join(' ') + '}';
}

// ★ 近战主路径：onAttackEntity(attacker, victim) —— 一定给到玩家对象
safeListen('onAttackEntity', (attacker, victim) => {
    try {
        const cfg = Config.get();
        if (cfg.enabled === false) return true;
        if (!rt.isPlayer(attacker)) return true;
        if (victim == null) return true;
        rt.onMeleeHit(attacker, victim, 0, 2);
    } catch (e) {
        log('[lore_enchant] onAttackEntity 出错: ' + e);
    }
    return true;
});

// onMobHurt：**护甲/领域类词条走这里**（受伤的是玩家时判定）
// 近战用 onAttackEntity，因为某些版本这里传的 source 不是玩家对象（hasGetHand=false）。
safeListen('onMobHurt', (mob, source, damage, cause) => {
    try {
        rt.stats.hurtEvent++;
        if (rt.stats.hurtEvent <= 3) {
            log('[lore_enchant] onMobHurt #' + rt.stats.hurtEvent
                + ' mob=' + desc(mob) + ' source=' + desc(source)
                + ' damage=' + damage + ' cause=' + cause);
        }

        const cfg = Config.get();
        if (cfg.enabled === false) return true;
        if (rt.busy > 0) return true;            // 自己造成的追加伤害，放过

        // 只有「被打的是玩家」才跑领域类词条（不依赖 source 是不是玩家对象）
        if (rt.isPlayer(mob)) {
            const dmg = Number(damage);
            const cs = Number(cause);
            if (rt.onPlayerHurt(mob, source, isFinite(dmg) ? dmg : 0, isFinite(cs) ? cs : 0)) {
                return false;                    // 词条要求拦截这次伤害
            }
        }
    } catch (e) {
        log('[lore_enchant] onMobHurt 出错: ' + e);
    }
    return true;
});

// 箭的射手映射（本版没有弓词条，先留着，方便以后加回来）
safeListen('onProjectileCreated', (shooter, entity) => {
    try {
        rt.rememberProjectile(shooter, entity);
    } catch (e) { }
});

safeListen('onServerStarted', () => {
    log('§b[lore_enchant] ' + BRAND + ' v' + VERSION.join('.') + ' §7已启用（雷神单测版）§8(/le 看词条)');
    if (Enchants.hasPassive()) rt.start();
});

// 热重载不会重发 onServerStarted
if (Enchants.hasPassive()) rt.start();

try {
    ll.onUnload(() => rt.stop());
} catch (e) { }
