"use strict";
/**
 * 运行时：把「玩家身上的词条」接到「游戏事件」上，并统一管冷却/概率/上下文。
 *
 * 分工：
 *   gear.js     读装备 + 解析缓存
 *   enchants.js 词条定义和它们各自的行为
 *   runtime.js  ← 这里：事件分发、概率、冷却、ctx 构造、拦截语义
 */
const { Config } = require("plugins/lore_enchant/src/config");
const { Enchants } = require("plugins/lore_enchant/src/enchants");
const gear = require("plugins/lore_enchant/src/gear");
const { roll, byLevel, slotMatches, shortType, fmtPos } = require("plugins/lore_enchant/src/util");

/** 伤害原因：0 = Override（脚本直接造成），我们自己打的追加伤害用它，靠它防递归 */
const CAUSE_OVERRIDE = 0;
const CAUSE_ENTITY_ATTACK = 2;
const CAUSE_PROJECTILE = 3;

function playerKey(player) {
    if (player == null) return '?';
    try {
        if (player.uuid != null) return String(player.uuid);
        if (player.xuid != null) return String(player.xuid);
        if (player.realName != null) return String(player.realName);
        return String(player.name);
    } catch (e) {
        return '?';
    }
}

/**
 * 判断一个实体是不是玩家 —— **多信号兜底**。
 * 只信 isPlayer() 是不够的：有些 LSE 版本的玩家对象没有这个方法，
 * 一旦判断失败，所有战斗词条都会静默不触发（插件不报错，最难查）。
 * getHand() 是玩家对象独有的，最可靠。
 */
function isPlayerEntity(entity) {
    if (entity == null) return false;
    try {
        if (typeof entity.isPlayer === 'function') {
            try { if (entity.isPlayer() === true) return true; } catch (e) { }
        }
        if (entity.isPlayer === true) return true;
        if (typeof entity.getHand === 'function') return true;
        if (typeof entity.getOffHand === 'function') return true;
        if (typeof entity.isOP === 'function') return true;
        const t = String(entity.type == null ? '' : entity.type).toLowerCase().replace(/^minecraft:/, '');
        if (t === 'player') return true;
    } catch (e) { }
    return false;
}

function safeNum(v, d) {
    const n = Number(v);
    return isFinite(n) ? n : d;
}

class Runtime {
    constructor() {
        /** 冷却：`玩家key:词条id` -> 到期时间戳(ms) */
        this.cooldowns = new Map();
        /** 弹射物 → 射手：`弹射物id` -> {key, at} */
        this.projectiles = new Map();
        this.timer = null;
        /** 正在执行词条效果的重入计数（自己造成的追加伤害会再触发 onMobHurt，靠它挡掉） */
        this.busy = 0;
        /** 插件启动时刻，onAttackEntity 兜底要等一会儿才启用，避免和 onMobHurt 抢 */
        this.startedAt = Date.now();
        /** 最近若干次判定过程，给 /le diag 看（排「为什么没触发」用） */
        this.lastDecisions = [];
        /** 统计，给 /le diag 用（hurtEvent = 事件到底有没有进到插件） */
        this.stats = { hurtEvent: 0, hit: 0, hurt: 0, projectile: 0, kill: 0, tick: 0, triggers: 0 };
    }

    cfg() {
        return Config.get();
    }

    /** 是不是玩家（多信号判断，见文件顶部 isPlayerEntity） */
    isPlayer(entity) {
        return isPlayerEntity(entity);
    }

    /** 记一条判定过程（保留最近 12 条） */
    note(text) {
        try {
            this.lastDecisions.push(String(text));
            if (this.lastDecisions.length > 12) this.lastDecisions.shift();
        } catch (e) { }
    }

    // ------------------------------------------------------------ 冷切
    /** 只检查冷却，不改状态 */
    cooling(key, id, cdMs) {
        if (!(cdMs > 0)) return false;
        const until = this.cooldowns.get(key + ':' + id) || 0;
        return Date.now() < until;
    }

    /** 判定通过后再落冷却（否则「摇失败」也会吃掉 400ms，手感会变差） */
    markCooldown(key, id, cdMs) {
        if (!(cdMs > 0)) return;
        const k = key + ':' + id;
        this.cooldowns.set(k, Date.now() + cdMs);
        if (this.cooldowns.size > 512) {
            const now = Date.now();
            for (const [kk, v] of this.cooldowns) {
                if (v <= now) this.cooldowns.delete(kk);
            }
        }
    }

    // ------------------------------------------------- 弹射物 → 射手映射
    rememberProjectile(shooter, proj) {
        try {
            if (shooter == null || proj == null) return;
            const id = (proj.id != null) ? String(proj.id) : null;
            if (id == null) return;
            this.projectiles.set(id, { key: playerKey(shooter), at: Date.now() });
            if (this.projectiles.size > 256) {
                const now = Date.now();
                for (const [k, v] of this.projectiles) {
                    if (now - v.at > 15000) this.projectiles.delete(k);
                }
            }
        } catch (e) { }
    }

    shooterOf(proj) {
        try {
            const id = (proj != null && proj.id != null) ? String(proj.id) : null;
            if (id == null) return null;
            const rec = this.projectiles.get(id);
            if (rec == null) return null;
            if (Date.now() - rec.at > 15000) {
                this.projectiles.delete(id);
                return null;
            }
            return rec.key;
        } catch (e) {
            return null;
        }
    }

    // ----------------------------------------------------------- ctx
    /**
     * 构造一个词条 handler 的上下文。
     * handler 拿到的东西都从这里来，方便离线测试整体替换。
     */
    makeCtx(player, target, level, damage, cause, params, api) {
        const self = this;
        const cfg = this.cfg();
        const showParticles = cfg.show_particles === true;
        return {
            player: player,
            target: target,
            level: level,
            damage: damage,
            cause: cause,
            params: params || {},
            cfg: cfg,
            rng: api && api.rng ? api.rng : Math.random,

            /** 给玩家自己发一条消息 */
            say: function (text) {
                try {
                    if (player != null && typeof player.tell === 'function') player.tell(String(text));
                } catch (e) { }
            },

            /** 播放音效（默认开，config 可关） */
            sound: function (name, pitch) {
                if (cfg.play_sounds === false) return;
                try {
                    const pos = fmtPos(player && player.pos);
                    if (pos != null) self.runcmd('playsound ' + name + ' @a ' + pos + ' 1 ' + (pitch || 1));
                } catch (e) { }
            },

            /** 给某个实体加药水效果 */
            effect: function (who, id, ticks, amp, particles) {
                // 有些事件（如 onMobHurt 的 source）给的是「实体视角的玩家」，
                // 没有 addEffect 方法；按名字换回真正的玩家对象再试一次。
                let w = who;
                if (w != null && typeof w.addEffect !== 'function') {
                    try {
                        if (typeof mc.getPlayer === 'function' && w.name != null) {
                            const real = mc.getPlayer(String(w.name));
                            if (real != null && typeof real.addEffect === 'function') w = real;
                        }
                    } catch (e) { }
                }
                try {
                    if (w == null || typeof w.addEffect !== 'function') return false;
                    const p = (particles == null) ? showParticles : particles === true;
                    return w.addEffect(Number(id), Math.max(1, Math.floor(Number(ticks) || 20)),
                        Math.max(0, Math.floor(safeNum(amp, 0))), p) !== false;
                } catch (e) {
                    return false;
                }
            },

            /** 治疗自己（单位：心） */
            healMe: function (hearts) {
                const n = Math.max(1, Math.floor(safeNum(hearts, 1)));
                try {
                    if (player != null && typeof player.heal === 'function') return player.heal(n) !== false;
                } catch (e) { }
                return false;
            },

            /**
             * 按「点血」精确治疗（1 点 = 1 点生命值，20 点 = 10 颗心）。
             * heal() 只能按「心」加，做不了 3 点血这种奇数，所以这里直接用 setHealth。
             */
            healHp: function (points) {
                const add = safeNum(points, 0);
                if (!(add > 0) || player == null) return false;
                try {
                    const cur = Number(player.health);
                    const max = Number(player.maxHealth);
                    if (!isFinite(cur)) return false;
                    const cap = isFinite(max) && max > 0 ? max : cur + add;
                    const next = Math.min(cap, cur + add);
                    if (typeof player.setHealth === 'function') {
                        return player.setHealth(next) !== false;
                    }
                    // 没有 setHealth 就退回按「心」治疗（向上取整，至少 1 心）
                    if (typeof player.heal === 'function') {
                        return player.heal(Math.max(1, Math.ceil(add / 2))) !== false;
                    }
                } catch (e) {
                    log('[lore_enchant] healHp 出错: ' + e);
                }
                return false;
            },

            /**
             * 对目标追加伤害。
             * 用 Override(0) 伤害原因：这样这条伤害不会再次进入「近战命中」分支，
             * 天然避免「吸血 → 伤害 → 再吸血」的无限递归。
             */
            hurtTarget: function (amount) {
                const dmg = safeNum(amount, 0);
                if (!(dmg > 0) || target == null) return false;
                // 追加伤害会再触发 onMobHurt，用 busy 计数挡掉那一次
                self.busy++;
                try {
                    if (typeof target.hurt === 'function') return target.hurt(dmg, CAUSE_OVERRIDE, player) !== false;
                } catch (e) {
                } finally {
                    self.busy--;
                }
                return false;
            },

            /**
             * 在指定位置召唤闪电。
             * ⚠️ 控制台的 summon 默认在主世界执行，所以下界/末地必须用
             * `execute in <dimension> run summon ...` 指定维度。
             * 维度未知（-1）时三种维度都试一遍。
             *
             * 有些服务器会直接拒绝 summon lightning_bolt（返回 `Unable to summon object`），
             * 这时自动走「模拟落雷」：爆炸特效 + 雷声 + 保证有伤害。
             *
             * @param {string} posStr "x y z"
             * @param {number} dimid 0=主世界 1=下界 2=末地 -1=未知
             * @param {string} [mode] 'auto'（默认）/ 'summon'（只试召唤）/ 'fake'（直接模拟）
             */
            lightningAt: function (posStr, dimid, mode) {
                if (posStr == null) return false;
                const m = (mode == null) ? 'auto' : String(mode);
                const d = Math.floor(safeNum(dimid, -1));

                if (m !== 'fake') {
                    // 已知维度就只试它；未知（-1）就三个维度都试
                    const dims = (d === 0 || d === 1 || d === 2) ? [d] : [0, 1, 2];
                    for (let k = 0; k < dims.length; k++) {
                        const dim = dims[k];
                        const dimName = (dim === 1) ? 'nether' : (dim === 2 ? 'the_end' : null);
                        const cmds = dimName != null
                            ? [
                                'execute in ' + dimName + ' run summon minecraft:lightning_bolt ' + posStr,
                                'execute in ' + dimName + ' run summon lightning_bolt ' + posStr,
                            ]
                            : [
                                'summon minecraft:lightning_bolt ' + posStr,
                                'summon lightning_bolt ' + posStr,
                            ];
                        for (let i = 0; i < cmds.length; i++) {
                            if (self.runcmd(cmds[i], { silent: true }) !== false) return true;
                        }
                    }

                    if (m === 'summon') {
                        log('[lore_enchant] 这台服务器不允许 summon lightning_bolt（把对应词条的 params.mode 改成 "fake" 可强制用模拟落雷）');
                        return false;
                    }
                    if (self.lastFakeNote !== true) {
                        self.lastFakeNote = true;
                        log('[lore_enchant] summon lightning_bolt 被服务器拒绝，已改用「模拟落雷」（雷声+伤害+爆炸特效）');
                    }
                }

                return this.fakeLightning(posStr, d);
            },

            /** 模拟落雷：雷声（带维度）+ 爆炸特效（不破坏方块）+ 兜底伤害 */
            fakeLightning: function (posStr, dimid) {
                const parts = String(posStr).trim().split(/\s+/);
                const x = Number(parts[0]);
                const y = Number(parts[1]);
                const z = Number(parts[2]);
                const d = Math.floor(safeNum(dimid, -1));
                let done = false;

                // 1) 爆炸做视觉（优先用实体的 pos 对象，它自带 dimid，能在正确维度炸）
                try {
                    if (typeof mc.explode === 'function') {
                        const posObj = (target != null && target.pos != null) ? target.pos : { x: x, y: y, z: z };
                        if (mc.explode(posObj, player, 0, 2.5, false, false) !== false) done = true;
                    }
                } catch (e) { }

                // 2) 爆炸不可用 → 直接对目标扣血（保证有伤害）
                if (!done) {
                    try {
                        if (target != null && typeof target.hurt === 'function') {
                            target.hurt(6, CAUSE_OVERRIDE, player);
                            done = true;
                        }
                    } catch (e) { }
                }

                // 3) 雷声：必须带上维度，否则控制台的 playsound 在主世界执行 → 「声音太远听不见」
                const sound = 'playsound ambient.weather.lightning.impact @a ' + posStr + ' 1 1';
                if (d === 1) {
                    self.runcmd('execute in nether run ' + sound, { silent: true });
                } else if (d === 2) {
                    self.runcmd('execute in the_end run ' + sound, { silent: true });
                } else {
                    self.runcmd(sound, { silent: true });
                }

                // 4) 粒子（名字可能不一样，失败就算了）
                try {
                    if (typeof mc.spawnParticle === 'function' && isFinite(x)) {
                        const posObj = (target != null && target.pos != null) ? target.pos : { x: x, y: y, z: z };
                        mc.spawnParticle(posObj, 'minecraft:lightning_bolt');
                    }
                } catch (e) { }

                return done;
            },

            /**
             * 目标（或玩家自己）所在维度：0=主世界 1=下界 2=末地，拿不到返回 -1。
             * ⚠️ 维度 id 挂在**坐标对象**上（pos.dimid），不是实体属性；
             *    读不到时 LSE 会给 -1，这时调用方应该三种维度都试一遍。
             */
            targetDim: function () {
                try {
                    const cands = [];
                    if (target != null) cands.push(target.pos, target);
                    if (player != null) cands.push(player.pos, player);
                    for (let i = 0; i < cands.length; i++) {
                        const o = cands[i];
                        if (o == null) continue;
                        const d = Number(o.dimid);
                        if (isFinite(d) && d >= 0) return Math.floor(d);
                    }
                } catch (e) { }
                return -1;
            },

            /** 直接秒杀目标（优先 en.kill()，再退回 setHealth(0)） */
            killTarget: function () {
                if (target == null) return false;
                try {
                    if (typeof target.kill === 'function') return target.kill() !== false;
                    if (typeof target.setHealth === 'function') return target.setHealth(0) !== false;
                    if (typeof target.hurt === 'function') {
                        return target.hurt(999999, CAUSE_OVERRIDE, player) !== false;
                    }
                } catch (e) {
                    log('[lore_enchant] killTarget 出错: ' + e);
                }
                return false;
            },

            /**
             * 原生爆炸（mc.explode）。用于**原版特效 + 击退**，isDestroy=false 时不会破坏地形。
             *
             * 关键：不同 LSE 版本参数个数不一样，猜签名会「调用成功但什么都不发生」。
             * 所以这里逐个签名试，并用**目标血量有没有掉**来判断到底哪个生效了。
             *
             * @returns {boolean} 真的炸到了东西
             */
            explodeAt: function (radius, destroy, fire) {
                if (target == null || target.pos == null) return false;
                if (typeof mc === 'undefined' || typeof mc.explode !== 'function') {
                    log('[lore_enchant] 这个版本没有 mc.explode');
                    return false;
                }

                const r = Math.max(1, safeNum(radius, 4));
                const d = destroy === true;
                const f = fire === true;
                const pos = target.pos;
                const dim = (target.dimid != null) ? target.dimid : ((player != null && player.dimid != null) ? player.dimid : 0);

                const hpOf = () => {
                    const h = Number(target.health);
                    return isFinite(h) ? h : null;
                };

                // 每个候选签名：调用 → 看目标血量掉没掉 → 掉了就是它
                const candidates = [
                    () => mc.explode(pos, player, 0, r, d, f),                                   // 文档 6 参
                    () => mc.explode(pos, player, r, d, f),                                      // 5 参（无 maxResistance）
                    () => mc.explode(pos.x, pos.y, pos.z, dim, player, 0, r, d, f),              // 9 参
                    () => mc.explode(pos.x, pos.y, pos.z, dim, player, r, d, f),                 // 8 参
                ];

                for (let i = 0; i < candidates.length; i++) {
                    const before = hpOf();
                    let ret = null;
                    try {
                        ret = candidates[i]();
                    } catch (e) {
                        ret = null;
                    }
                    if (ret === false) continue;                 // 明确失败 → 试下一个

                    const after = hpOf();
                    if (before != null && after != null && after < before) {
                        // 血量掉了 = 这个签名真的生效了
                        return true;
                    }
                    // 血量没变：可能目标本来就满血没被打到，也可能是签名错位。
                    // 这种情况继续试下一个签名，最后交给手动伤害兜底。
                }
                return false;
            },

            /**
             * 自己算的爆炸兜底（原生爆炸不可用时）：范围内所有实体（**包括自己**）扣血 +
             * 尽力击退（有 setVelocity 就推）+ 粒子/音效。
             * @returns {number} 打到几个实体
             */
            blastAt: function (radius, damage) {
                if (target == null || target.pos == null) return 0;
                const r = Math.max(1, safeNum(radius, 4));
                const base = Math.max(1, safeNum(damage, 8));
                const pos = target.pos;
                const src = player;

                let list = [];
                try {
                    if (typeof mc.getEntities === 'function') list = mc.getEntities(pos, r) || [];
                } catch (e) { }
                if (list.length === 0 && src != null) {
                    // 兜底：把自己和目标都算进去
                    list = [target];
                    if (src !== target) list.push(src);
                }

                let hitCount = 0;
                for (let i = 0; i < list.length; i++) {
                    const one = list[i];
                    if (one == null) continue;

                    let dist = 0;
                    try { dist = self.distance(pos, one.pos); } catch (e) { dist = 0; }
                    const k = Math.max(0.3, 1 - (dist / r) * 0.7);
                    const dmg = Math.max(1, Math.round(base * k * 10) / 10);

                    try {
                        if (typeof one.hurt === 'function') {
                            one.hurt(dmg, CAUSE_OVERRIDE, src);
                            hitCount++;
                        }
                    } catch (e) { }

                    // 击退：有 setVelocity 就朝反方向推
                    try {
                        if (typeof one.setVelocity === 'function' && one.pos != null) {
                            const dx = Number(one.pos.x) - Number(pos.x);
                            const dy = Number(one.pos.y) - Number(pos.y);
                            const dz = Number(one.pos.z) - Number(pos.z);
                            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                            const power = 0.6 * k;
                            one.setVelocity((dx / len) * power, Math.max(0.25, (dy / len) * power + 0.3), (dz / len) * power);
                        }
                    } catch (e) { }
                }

                // 粒子 + 音效（尽力而为，失败不影响伤害）
                try {
                    if (typeof mc.spawnParticle === 'function') {
                        mc.spawnParticle(pos, 'minecraft:huge_explosion_emitter');
                        mc.spawnParticle(pos, 'minecraft:explosion_manual');
                    }
                } catch (e) { }
                const posStr = fmtPos(pos);
                if (posStr != null) self.runcmd('playsound random.explode @a ' + posStr + ' 1 1');

                return hitCount;
            },

            /** 两点距离（FloatPos 对象） */
            distance: function (a, b) {
                if (a == null || b == null) return 9999;
                const dx = Number(a.x) - Number(b.x);
                const dy = Number(a.y) - Number(b.y);
                const dz = Number(a.z) - Number(b.z);
                if (!isFinite(dx) || !isFinite(dy) || !isFinite(dz)) return 9999;
                return Math.sqrt(dx * dx + dy * dy + dz * dz);
            },

            /** 全服广播（mc.broadcast，失败就逐个私聊兜底） */
            broadcast: function (text) {
                const msg = String(text == null ? '' : text);
                try {
                    if (typeof mc !== 'undefined' && typeof mc.broadcast === 'function') {
                        return mc.broadcast(msg) !== false;
                    }
                } catch (e) { }
                try {
                    const players = mc.getOnlinePlayers() || [];
                    for (let i = 0; i < players.length; i++) {
                        const p = players[i];
                        if (p != null && typeof p.tell === 'function') p.tell(msg);
                    }
                    return true;
                } catch (e) { }
                return false;
            },

            /** 目标坐标字符串 */
            targetPos: function () {
                return fmtPos(target && target.pos);
            },
        };
    }

    /**
     * 执行一条后台命令。
     * 优先用 mc.runcmdEx：它**不会把执行结果打到控制台**
     * （普通 mc.runcmd 每次都会打 `[Server] Object successfully summoned`，召唤类词条会刷屏）。
     *
     * @param {string} cmd
     * @param {{silent?:boolean}} [opts] silent=true 时不打失败日志（用于连续试多种写法）
     */
    runcmd(cmd, opts) {
        const silent = (opts != null && opts.silent === true);
        try {
            if (typeof mc === 'undefined') return false;

            if (typeof mc.runcmdEx === 'function') {
                let res = null;
                try {
                    res = mc.runcmdEx(cmd);
                } catch (e) {
                    if (!silent) log('[lore_enchant] runcmdEx 抛错: ' + cmd + ' -> ' + e);
                    res = null;
                }
                if (res != null) {
                    if (typeof res === 'object') {
                        if (res.success !== false) return true;
                        if (!silent) log('[lore_enchant] 命令执行失败: ' + cmd + ' -> ' + JSON.stringify(res));
                    } else if (res !== false) {
                        return true;
                    } else if (!silent) {
                        log('[lore_enchant] 命令执行失败(false): ' + cmd);
                    }
                }
                if (typeof mc.runcmd === 'function') {
                    try {
                        const r2 = mc.runcmd(cmd);
                        if (r2 !== false) return true;
                        if (!silent) log('[lore_enchant] mc.runcmd 也失败(false): ' + cmd);
                    } catch (e2) {
                        if (!silent) log('[lore_enchant] mc.runcmd 抛错: ' + cmd + ' -> ' + e2);
                    }
                }
                return false;
            }

            if (typeof mc.runcmd === 'function') {
                const r = mc.runcmd(cmd);
                if (r !== false) return true;
                if (!silent) log('[lore_enchant] 命令执行失败(false): ' + cmd);
            }
        } catch (e) {
            if (!silent) log('[lore_enchant] 命令执行失败: ' + cmd + ' -> ' + e);
        }
        return false;
    }

    // -------------------------------------------------- 通用分发（核心）
    /**
     * 把一件装备上的词条按 trigger 跑一遍。
     * @returns {boolean} true = 调用方应拦截该事件
     */
    /**
     * 每个玩家第一次「命中判定」时往控制台打一条，内容是最近的判定过程。
     * 目的：让排障不需要敲命令 —— 打一下怪，看控制台就知道是「没解析到」还是「概率没中」。
     */
    logFirstHit(trigger, key) {
        if (trigger !== 'hit') return;
        if (this.hitLogged == null) this.hitLogged = {};
        if (this.hitLogged[key] === true) return;
        this.hitLogged[key] = true;
        const tail = this.lastDecisions.slice(-3).join(' | ');
        log('[lore_enchant] 首次命中判定（' + key + '）：' + (tail || '无记录'));
    }

    dispatch(trigger, player, target, item, enchants, damage, cause, api) {
        const cfg = this.cfg();
        if (cfg.enabled === false) return false;
        const key0 = playerKey(player);
        const size = (enchants == null) ? 0 : enchants.size;
        if (size === 0) {
            // 把「手持什么、读到几行」也写进去，别只给结论
            let detail = '';
            try {
                const lines = gear.readLore(item);
                detail = '手持 §f' + String(item && item.type ? item.type : '空')
                    + ' §7，读到 §f' + lines.length + ' §7行 lore';
            } catch (e) {
                detail = '读 lore 出错';
            }
            this.note(trigger + '：装备上没有解析到词条（' + detail + '）');
            this.logFirstHit(trigger, key0);
            return false;
        }
        const key = key0;
        let cancel = false;

        for (const [id, level] of enchants) {
            const one = Config.forEnchant(id);
            const def = one.def;
            const label = def ? Enchants.label(def, level) : String(id);
            if (def == null) { this.note(label + ' 词条不存在'); continue; }
            if (one.enabled === false) { this.note(label + ' 配置里已禁用'); continue; }
            if (def.trigger !== trigger) continue;
            if (item != null && !slotMatches(item.type, def.slot)) {
                this.note(label + ' 槽位不匹配（物品 ' + shortType(item.type) + '，词条需要 ' + def.slot + '）');
                continue;
            }

            const chance = (Array.isArray(one.chance) && one.chance.length > 0)
                ? byLevel(one.chance, level)
                : (def.trigger === 'tick' ? 100 : 0);
            if (chance <= 0) { this.note(label + ' 概率为 0'); continue; }
            if (this.cooling(key, id, one.cooldown_ms)) {
                this.note(label + ' 冷却中（' + one.cooldown_ms + 'ms）');
                continue;
            }

            const r = (api != null && typeof api.rng === 'function') ? api.rng() : Math.random();
            if (r * 100 >= chance) {
                this.note(label + ' 概率 ' + chance + '%，这次没中（roll ' + (r * 100).toFixed(1) + '）');
                continue;
            }
            this.markCooldown(key, id, one.cooldown_ms);

            const ctx = this.makeCtx(player, target, level, damage, cause, one.params, api);
            let cancelled = null;
            try {
                cancelled = def.run(ctx);
            } catch (e) {
                log('[lore_enchant] 词条 ' + id + ' 执行出错: ' + e);
                cancelled = null;
            }
            this.stats.triggers++;
            this.note(label + ' 命中！' + (cancelled === false ? '（并拦截了这次事件）' : ''));
            if (cfg.log_triggers === true) {
                log('[lore_enchant] ' + label + ' 触发（' + key + '，' + trigger + '）');
            }
            if (cancelled === false) cancel = true;
        }
        this.logFirstHit(trigger, key);
        return cancel;
    }

    // ------------------------------------------------------------ 事件入口
    /** 近战命中：source 是玩家、cause = EntityAttack */
    onMeleeHit(player, target, damage, cause, api) {
        this.stats.hit++;
        const cfg = this.cfg();
        const item = gear.handItem(player);
        if (item == null) return false;
        const enchants = gear.enchantsOf(item, cfg);
        return this.dispatch('hit', player, target, item, enchants, damage, cause, api);
    }

    /** 箭命中：从弹射物反查射手 */
    onProjectileHit(victim, projectile, damage, cause, api) {
        this.stats.projectile++;
        const key = this.shooterOf(projectile);
        if (key == null) return false;
        const player = this.findPlayerByKey(key);
        if (player == null) return false;
        const cfg = this.cfg();
        const item = gear.handItem(player);
        if (item == null) return false;
        const enchants = gear.enchantsOf(item, cfg);
        return this.dispatch('projectile', player, victim, item, enchants, damage, cause, api);
    }

    /** 玩家受伤：跑防御类词条，返回 true 表示要取消这次伤害 */
    onPlayerHurt(player, source, damage, cause, api) {
        this.stats.hurt++;
        const cfg = this.cfg();
        const armor = gear.armorItems(player);
        let cancel = false;
        const names = ['头盔', '胸甲', '护腿', '靴子'];
        for (let i = 0; i < armor.length; i++) {
            const item = armor[i];
            if (item == null) continue;
            const enchants = gear.enchantsOf(item, cfg);
            if (this.dispatch('hurt', player, source, item, enchants, damage, cause, api)) cancel = true;
        }
        return cancel;
    }

    /** 击杀：source 是玩家 */
    onKill(mob, source, api) {
        if (!isPlayerEntity(source)) return false;
        this.stats.kill++;
        const cfg = this.cfg();
        const item = gear.handItem(source);
        if (item == null) return false;
        const enchants = gear.enchantsOf(item, cfg);
        return this.dispatch('kill', source, mob, item, enchants, 0, 0, api);
    }

    /** 每秒轮询：盔甲被动（夜视/生命提升） */
    onPassiveTick() {
        const cfg = this.cfg();
        if (cfg.enabled === false) return;
        let players = [];
        try {
            players = mc.getOnlinePlayers() || [];
        } catch (e) {
            return;
        }
        for (let p = 0; p < players.length; p++) {
            const player = players[p];
            if (player == null) continue;
            this.stats.tick++;
            const armor = gear.armorItems(player);
            for (let i = 0; i < armor.length; i++) {
                const item = armor[i];
                if (item == null) continue;
                const enchants = gear.enchantsOf(item, cfg);
                if (enchants.size === 0) continue;
                this.dispatch('tick', player, null, item, enchants, 0, 0);
            }
        }
    }

    findPlayerByKey(key) {
        try {
            const players = mc.getOnlinePlayers() || [];
            for (let i = 0; i < players.length; i++) {
                if (playerKey(players[i]) === key) return players[i];
            }
        } catch (e) { }
        return null;
    }

    // ------------------------------------------------------------ 生命周期
    start() {
        this.stop();
        const cfg = this.cfg();
        const ms = Math.max(250, safeNum(cfg.passive_interval_ms, 1000));
        this.timer = setInterval(() => {
            try {
                this.onPassiveTick();
            } catch (e) {
                log('[lore_enchant] 轮询出错: ' + e);
            }
        }, ms);
    }

    stop() {
        if (this.timer != null) {
            try {
                clearInterval(this.timer);
            } catch (e) { }
            this.timer = null;
        }
    }

    restart() {
        gear.clearCache();
        Config.load();
        this.cooldowns.clear();
        this.projectiles.clear();
        this.start();
    }
}

exports.Runtime = Runtime;
exports.playerKey = playerKey;
exports.isPlayerEntity = isPlayerEntity;
exports.CAUSE_OVERRIDE = CAUSE_OVERRIDE;
exports.CAUSE_ENTITY_ATTACK = CAUSE_ENTITY_ATTACK;
exports.CAUSE_PROJECTILE = CAUSE_PROJECTILE;
