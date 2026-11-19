"use strict";
/**
 * 离线自测（词条版，不需要 BDS，只要 Node 18+）：
 *
 *     node test/offline-test.js
 *
 * 覆盖：lore 解析（各种写法）、读 lore 的两条路（属性 / NBT）、槽位匹配、
 *       概率分档、冷却（摇中才落）、拦截语义、缓存不串味、配置生成。
 */
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    const m = /^plugins\/lore_enchant\/(.*)$/.exec(request);
    if (m) return origLoad.call(this, path.join(ROOT, m[1] + '.js'), parent, isMain);
    return origLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------- 全局桩
const logs = [];
global.log = (s) => logs.push(String(s));

const files = new Map();
global.File = {
    exists: (p) => files.has(p),
    readFrom: (p) => (files.has(p) ? files.get(p) : null),
    writeTo: (p, v) => { files.set(p, String(v)); return true; },
    delete: (p) => { files.delete(p); return true; },
    createDir: () => true,
};

const runcmds = [];      // mc.runcmd —— 会把结果打到控制台（召唤类会刷屏，不该用它）
const runexCmds = [];    // mc.runcmdEx —— 隐藏输出，插件应该走这个
const broadcasts = [];
const explosions = [];
global.mc = {
    runcmd: (c) => { runcmds.push(String(c)); return true; },
    runcmdEx: (c) => { runexCmds.push(String(c)); return { success: true, output: '' }; },
    broadcast: (m) => { broadcasts.push(String(m)); return true; },
    getEntities: (pos, radius) => global.__blastList || [],
    explode: function () {
        const args = Array.prototype.slice.call(arguments);
        explosions.push({ argc: args.length, args: args });
        const t = global.__blastTarget;
        if (global.__blastMode === 'none') return true;              // 全部「成功」但什么都不做
        // 模拟：只有 5 参形式真的生效（其他签名错位 → 无效）
        if (args.length === 5 && t != null) { t.health -= 5; return true; }
        return true;
    },
    getOnlinePlayers: () => [],
};

// ---------------------------------------------------------------- 断言
let passed = 0;
const failures = [];
function ok(cond, name) {
    if (cond) { passed++; return; }
    failures.push(name);
    console.log('  ✗ ' + name);
}
function eq(actual, expected, name) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a === b) { passed++; return; }
    failures.push(name + '  (got ' + a + ', want ' + b + ')');
    console.log('  ✗ ' + name + '  got ' + a + ' want ' + b);
}

// ---------------------------------------------------------------- 被测模块
const { Config } = require('plugins/lore_enchant/src/config');
const { Enchants } = require('plugins/lore_enchant/src/enchants');
const { parseLine, parseItem, parseLines, romanToInt } = require('plugins/lore_enchant/src/parse');
const { slotMatches, byLevel, fmtPos } = require('plugins/lore_enchant/src/util');
const gear = require('plugins/lore_enchant/src/gear');
const { Runtime } = require('plugins/lore_enchant/src/runtime');

// ---------------------------------------------------------------- 假对象
const RNG_HIT = { rng: () => 0 };
const RNG_MISS = { rng: () => 0.999 };

function makeItem(type, lore, name) {
    return { type: type, name: name || type, lore: Array.isArray(lore) ? lore.slice() : [], count: 1 };
}
function makePlayer(opts) {
    const o = opts || {};
    return {
        uuid: o.uuid || 'p-1',
        name: o.name || 'Steve',
        pos: { x: 0, y: 64, z: 0 },
        health: o.health != null ? o.health : 20,
        maxHealth: o.maxHealth != null ? o.maxHealth : 20,
        msgs: [],
        healed: 0,
        tell(t) { this.msgs.push(String(t)); return true; },
        heal(n) { this.healed += Number(n); return true; },
        setHealth(n) { this.health = Number(n); return true; },
        hurtTaken: 0,
        hurt(d) { this.hurtTaken += Number(d) || 0; this.health -= Number(d) || 0; return true; },
        addEffect() { return true; },
        isPlayer() { return true; },
        getHand() { return o.hand || null; },
        getOffHand() { return o.off || null; },
        getArmor() { return { getAllItems: () => (o.armor || []) }; },
        isOP() { return o.op === true; },
    };
}
function makeMob(health) {
    return {
        id: 'mob-' + Math.random().toString(36).slice(2),
        name: 'Zombie',
        health: health != null ? health : 20,
        maxHealth: 20,
        pos: { x: 10, y: 64, z: 10 },
        hurtCalls: [],
        effects: [],
        isPlayer() { return false; },
        hurt(d, cause) { this.hurtCalls.push({ d: d, cause: cause }); return true; },
        killCalls: 0,
        kill() { this.killCalls++; this.health = 0; return true; },
        addEffect(id, ticks, amp) { this.effects.push({ id: id, ticks: ticks, amp: amp }); return true; },
    };
}

// ============================================================ 1. 解析器
console.log('\n[1] lore 解析');
Config.load();

eq(parseLine('雷神III'), [{ id: 'thunder', name: '雷神', level: 3 }], '雷神III');
eq(parseLine('雷神 3级'), [{ id: 'thunder', name: '雷神', level: 3 }], '雷神 3级');
eq(parseLine('雷神 等级4'), [{ id: 'thunder', name: '雷神', level: 4 }], '雷神 等级4');
eq(parseLine('雷神Lv.2'), [{ id: 'thunder', name: '雷神', level: 2 }], '雷神Lv.2');
eq(parseLine('雷神+2'), [{ id: 'thunder', name: '雷神', level: 2 }], '雷神+2');
eq(parseLine('雷神1'), [{ id: 'thunder', name: '雷神', level: 1 }], '雷神1（用户原始写法）');
eq(parseLine('thunder:4')[0].level, 4, 'thunder:4');
eq(parseLine('§c雷神§r III')[0].level, 3, '带颜色码');
eq(parseLine('雷神IX')[0].level, 9, '罗马 IX = 9 级');
eq(parseLine('雷神X')[0].level, 10, '罗马 X = 10 级（新上限）');
eq(parseLine('雷神XI')[0].level, 10, '超过 10 级压到 10');
eq(romanToInt('IX'), 9, '罗马 IX');
eq(parseLine('雷神').length, 0, '只写名字不生效（require_level）');
eq(parseLine('雷神', { requireLevel: false })[0].level, 1, 'requireLevel=false 时按 I 级');
eq(parseLine('淬毒III'), [{ id: 'poison', name: '淬毒', level: 3 }], '淬毒III');
eq(parseLine('淬毒10')[0].level, 10, '淬毒10 = 10 级');
eq(parseLine('poison7')[0].level, 7, 'poison7 英文 id');
eq(parseLine('百毒不侵III').length, 0, '「百毒不侵」不会被当成淬毒（没把「毒」当别名）');
eq(parseLine('淬毒').length, 0, '只写名字不生效');
eq(parseLine('攻击速度+10%').length, 0, '百分号行不算');
eq(parseLine('暴击概率 5%').length, 0, '黑名单行跳过');
eq(parseLine('雷神III', { marker: '⬥' }).length, 0, 'marker 不匹配 → 不解析');
eq(parseLine('⬥ 雷神III', { marker: '⬥' }).length, 1, 'marker 匹配 → 解析');
eq(parseLines({ length: 1, 0: '雷神V' }, {}).get('thunder'), 5, 'parseLines 支持类数组');

// ============================================================ 2. 物品级解析 / 缓存
console.log('\n[2] 物品级解析 / 缓存');
const sword = makeItem('minecraft:netherite_sword', ['雷神III']);
eq(parseItem(sword, { requireLevel: true }).get('thunder'), 3, 'parseItem 拿到 3 级');

const a = gear.enchantsOf(sword, Config.get());
const b = gear.enchantsOf(sword, Config.get());
ok(a === b, '同样 lore 命中缓存（同一个 Map 实例）');
eq(gear.enchantsOf(makeItem('minecraft:iron_sword', ['雷神I']), Config.get()).get('thunder'), 1, '不同 lore 不串味');

// ============================================================ 3. 读 lore 的两条路
console.log('\n[3] 读 lore：item.lore / 类数组 / NBT 回退');
eq(gear.readLore(makeItem('minecraft:iron_sword', ['雷神II'])), ['雷神II'], '普通数组');
const arrayLike = { type: 'minecraft:iron_sword', name: '剑', lore: { length: 1, 0: '雷神III' } };
eq(gear.readLore(arrayLike), ['雷神III'], '类数组（不是 Array.isArray）');

function makeNbtItem(type, lines) {
    const loreList = { getSize: () => lines.length, getData: (i) => lines[i] };
    const display = { getTag: (k) => (k === 'Lore' ? loreList : null) };
    const tag = { getTag: (k) => (k === 'display' ? display : null) };
    return { type: type, name: type, lore: [], getNbt: () => ({ getTag: (k) => (k === 'tag' ? tag : null) }) };
}
const nbtOnly = makeNbtItem('minecraft:diamond_sword', ['雷神V']);
eq(gear.readLore(nbtOnly), ['雷神V'], 'NBT 回退');
eq(gear.enchantsOf(nbtOnly, Config.get()).get('thunder'), 5, 'NBT 里的词条能解析');
eq(gear.readLore({ type: 'minecraft:stick', name: '木棍' }), [], '没有 lore 返回空数组');

// ============================================================ 4. 槽位 / 数值
console.log('\n[4] 槽位匹配 / 概率分档');
ok(slotMatches('minecraft:netherite_sword', 'weapon'), '剑 → weapon');
ok(slotMatches('minecraft:iron_axe', 'weapon'), '斧 → weapon');
ok(slotMatches('minecraft:trident', 'weapon'), '三叉戟 → weapon');
ok(!slotMatches('minecraft:bow', 'weapon'), '弓不是 weapon');
eq(byLevel([5, 12.5, 20], 1), 5, '一级 5%');
eq(byLevel([5, 12.5, 20], 9), 20, '超出取最后一档');
eq(fmtPos({ x: 1.234, y: 64, z: -3.456 }), '1.2 64.0 -3.5', '坐标格式化');

// ============================================================ 5. 触发
console.log('\n[5] 近战触发（雷神）');
const rt = new Runtime();
const player = makePlayer({ hand: makeItem('minecraft:netherite_sword', ['雷神III']) });
const mob = makeMob(100);

function resetCmds() { runcmds.length = 0; runexCmds.length = 0; }

resetCmds();
rt.onMeleeHit(player, mob, 0, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt') === 0), '召唤了闪电（走 runcmdEx）');
ok(runexCmds.some((c) => c.indexOf('10.0 64.0 10.0') > 0), '闪电打在目标坐标');
eq(runcmds.length, 0, '没有走会打屏的 mc.runcmd');
eq(player.msgs.length, 0, '默认**不**给玩家发提示（announce_triggers 默认关闭）');

// 冷却：本版默认 cooldown_ms = 0（7 级 100% 要保证每下都出），这里手动给 200 测冷却逻辑
Config.current.enchants.thunder.cooldown_ms = 200;
rt.cooldowns.clear();
resetCmds();
rt.onMeleeHit(player, mob, 0, 2, RNG_HIT);
eq(runexCmds.length, 1, '第一次触发');
resetCmds();
rt.onMeleeHit(player, mob, 0, 2, RNG_HIT);
eq(runexCmds.length, 0, '冷却期内不重复触发');
Config.current.enchants.thunder.cooldown_ms = 0;

// 概率没中
rt.cooldowns.clear();
resetCmds();
rt.onMeleeHit(player, mob, 0, 2, RNG_MISS);
eq(runexCmds.length, 0, '概率没中不触发');
ok(rt.lastDecisions.length > 0, '没中也会记一条判定（给 /le diag 看）');

// 摇失败不吃冷却：紧接着用必中再打一次，应该能触发
resetCmds();
rt.onMeleeHit(player, mob, 0, 2, RNG_HIT);
ok(runexCmds.length > 0, '摇失败不占冷却（下一次必中能触发）');

// 打开 announce_triggers 才有提示
Config.current.announce_triggers = true;
rt.cooldowns.clear();
player.msgs.length = 0;
resetCmds();
rt.onMeleeHit(player, mob, 0, 2, RNG_HIT);
ok(player.msgs.some((m) => m.indexOf('雷神之力！！！') >= 0), '打开 announce_triggers 后发「雷神之力！！！」');
Config.current.announce_triggers = false;

// 没有 lore
rt.cooldowns.clear();
resetCmds();
const bare = makePlayer({ uuid: 'p-bare', hand: makeItem('minecraft:iron_sword', []) });
rt.onMeleeHit(bare, mob, 0, 2, RNG_HIT);
eq(runexCmds.length, 0, '没 lore 不触发');
ok(rt.lastDecisions.join('|').indexOf('没有解析到词条') >= 0, '判定记录里说明了「没有解析到词条」');

// 槽位不匹配（把雷神写在弓上）
rt.cooldowns.clear();
resetCmds();
const bowPlayer = makePlayer({ uuid: 'p-bow', hand: makeItem('minecraft:bow', ['雷神III']) });
rt.onMeleeHit(bowPlayer, mob, 0, 2, RNG_HIT);
eq(runexCmds.length, 0, '弓上的雷神不触发');
ok(rt.lastDecisions.join('|').indexOf('槽位不匹配') >= 0, '判定记录里说明了「槽位不匹配」');

// ============================================================ 6. 淬毒
console.log('\n[6] 淬毒：中毒 3 秒、强度跟着等级');
const poisoner = makePlayer({ uuid: 'p-poison', hand: makeItem('minecraft:iron_sword', ['淬毒III']) });
const victim1 = makeMob(50);
rt.cooldowns.clear();
rt.onMeleeHit(poisoner, victim1, 5, 2, RNG_HIT);
eq(victim1.effects.length, 1, '给目标上了 1 个效果');
eq(victim1.effects[0].id, 19, '效果 id = 19（中毒）');
eq(victim1.effects[0].ticks, 60, '时长 60 刻 = 3 秒');
eq(victim1.effects[0].amp, 3, '3 级淬毒 → amp=3（游戏显示「中毒 IV」；想显示 III 就把 amplifierOffset 改 -1）');

// 1 级 → amp 1（显示 中毒 II），对照你的要求
const poisoner1 = makePlayer({ uuid: 'p-poison1', hand: makeItem('minecraft:iron_sword', ['淬毒1']) });
const victim2 = makeMob(50);
rt.cooldowns.clear();
rt.onMeleeHit(poisoner1, victim2, 5, 2, RNG_HIT);
eq(victim2.effects[0].amp, 1, '1 级淬毒 → amp=1（显示 中毒 II，符合「1 级是 2」）');

// 10 级 → amp 10
const poisoner10 = makePlayer({ uuid: 'p-poison10', hand: makeItem('minecraft:iron_sword', ['淬毒X']) });
const victim3 = makeMob(50);
rt.cooldowns.clear();
rt.onMeleeHit(poisoner10, victim3, 5, 2, RNG_HIT);
eq(victim3.effects[0].amp, 10, '10 级淬毒 → amp=10');

// 概率和雷神一致
const pDef = Enchants.byId('poison');
const tDef = Enchants.byId('thunder');
eq(pDef.chance, tDef.chance, '淬毒概率数组和雷神完全一致');
eq(pDef.maxLevel, 10, '淬毒最高 10 级');

// ============================================================ 6b. 死亡
console.log('\n[6b] 死亡：凋零 3 秒、强度跟着等级');
const witherer = makePlayer({ uuid: 'p-wither', hand: makeItem('minecraft:iron_sword', ['死亡IV']) });
const wVictim = makeMob(50);
rt.cooldowns.clear();
rt.onMeleeHit(witherer, wVictim, 5, 2, RNG_HIT);
eq(wVictim.effects.length, 1, '给目标上了 1 个效果');
eq(wVictim.effects[0].id, 20, '效果 id = 20（凋零）');
eq(wVictim.effects[0].ticks, 60, '时长 60 刻 = 3 秒');
eq(wVictim.effects[0].amp, 4, '4 级死亡 → amp=4（显示「凋零 V」）');

const wDef = Enchants.byId('wither');
eq(wDef.chance, Enchants.byId('poison').chance, '死亡概率和淬毒完全一致');
eq(wDef.maxLevel, 10, '死亡最高 10 级');
eq(parseLine('死亡10')[0].id, 'wither', '「死亡10」能解析成语条');
eq(parseLine('wither7')[0].level, 7, 'wither7 英文 id');
eq(parseLine('死亡')[0], undefined, '只写「死亡」不生效（必须带等级）');

// ============================================================ 6c. 状态类词条
console.log('\n[6c] 侵袭/饥荒/冰冻/飞升/掠袭：各自对应正确效果');
const effectCases = [
    { lore: '侵袭III', id: 'blind', fx: 15, name: '侵袭' },
    { lore: '饥荒III', id: 'famine', fx: 17, name: '饥荒' },
    { lore: '冰冻III', id: 'chill', fx: 2, name: '冰冻' },
    { lore: '飞升III', id: 'ascend', fx: 24, name: '飞升' },
    { lore: '掠袭III', id: 'raid', fx: 30, name: '掠袭' },
];
for (const c of effectCases) {
    const pl = makePlayer({ uuid: 'p-' + c.id, hand: makeItem('minecraft:iron_sword', [c.lore]) });
    const v = makeMob(50);
    rt.cooldowns.clear();
    rt.onMeleeHit(pl, v, 5, 2, RNG_HIT);
    eq(v.effects.length, 1, c.name + ' 给目标上了 1 个效果');
    eq(v.effects[0].id, c.fx, c.name + ' 效果 id = ' + c.fx);
    eq(v.effects[0].ticks, 60, c.name + ' 持续 3 秒');
    if (c.id === 'famine') {
        eq(v.effects[0].amp, 254, c.name + ' 强度固定 amp=254（显示 255），不随等级变');
    } else {
        eq(v.effects[0].amp, 3, c.name + ' 3 级 → amp=3');
    }
    eq(Enchants.byKey(c.name).id, c.id, '「' + c.name + '」解析成 ' + c.id);
}

// 所有状态类词条的等级/概率/时长都与淬毒一致
const poisonDef = Enchants.byId('poison');
for (const id of ['wither', 'blind', 'famine', 'chill', 'ascend', 'raid']) {
    const d = Enchants.byId(id);
    eq(d.maxLevel, 10, id + ' 最高 10 级');
    eq(d.chance, poisonDef.chance, id + ' 概率和淬毒一致');
    eq(d.params.ticks, poisonDef.params.ticks, id + ' 时长和淬毒一致');
    eq(d.slot, 'weapon', id + ' 只适用武器');
}

// ============================================================ 6d. 饥荒固定强度
console.log('\n[6d] 饥荒：不管几级都挂 255 级饥饿');
const famineDef = Enchants.byId('famine');
eq(famineDef.params.fixedAmplifier, 254, 'params.fixedAmplifier = 254（显示 255）');
eq(famineDef.chance, Enchants.byId('poison').chance, '概率照旧（和淬毒一致）');
for (const lv of [1, 5, 10]) {
    const pl = makePlayer({ uuid: 'p-famine-' + lv, hand: makeItem('minecraft:iron_sword', ['饥荒' + lv]) });
    const v = makeMob(50);
    rt.cooldowns.clear();
    rt.onMeleeHit(pl, v, 5, 2, RNG_HIT);
    eq(v.effects.length, 1, '饥荒' + lv + ' 触发了');
    eq(v.effects[0].id, 17, '饥荒' + lv + ' 效果 id = 17（饥饿）');
    eq(v.effects[0].amp, 254, '饥荒' + lv + ' 强度仍是 254');
}

// ============================================================ 6e. XiYingKill（秒杀）
console.log('\n[6e] XiYingKill：秒杀 + 红色 + 全服播报');
const killDef = Enchants.byId('xiying_kill');
eq(killDef.name, 'XiYingKill', '名字是 XiYingKill');
eq(killDef.maxLevel, 11, '最高 11 级');
eq(killDef.chance, [3, 13, 23, 33, 43, 53, 63, 73, 83, 93, 100], '概率 3% 起每级 +10%，11 级 100%');
eq(killDef.color, '§c', '词条颜色是红色');

// 命中 3 级 → 应该 kill 目标，并**只给触发者自己**发「抹杀目标」
const killer2 = makePlayer({ uuid: 'p-kill', hand: makeItem('minecraft:netherite_sword', ['XiYingKill3']) });
const bystander = makePlayer({ uuid: 'p-bystander', name: 'Bystander' });
const doomed = makeMob(100);
rt.cooldowns.clear();
broadcasts.length = 0;
killer2.msgs.length = 0;
bystander.msgs.length = 0;
rt.onMeleeHit(killer2, doomed, 5, 2, RNG_HIT);
eq(doomed.killCalls, 1, '目标被 kill() 秒杀');
eq(killer2.msgs.length, 1, '触发者收到一条提示');
eq(killer2.msgs[0], '§c抹杀目标', '提示内容是红色的「抹杀目标」');
eq(broadcasts.length, 0, '没有走全服广播');
eq(bystander.msgs.length, 0, '旁边的玩家收不到（只给触发者）');

// 关掉播报（config 里 params.announce=false）
Config.current.enchants.xiying_kill.params = Object.assign({}, Config.current.enchants.xiying_kill.params, { announce: false });
rt.cooldowns.clear();
killer2.msgs.length = 0;
rt.onMeleeHit(killer2, makeMob(50), 5, 2, RNG_HIT);
eq(killer2.msgs.length, 0, '关掉 announce 后连自己也不提示');
Config.current.enchants.xiying_kill.params.announce = true;

// lore 行是红色
const line = require('plugins/lore_enchant/src/loreedit').lineFor(killDef, 2);
ok(line.indexOf('§c') === 0 && line.indexOf('XiYingKill') > 0, 'lore 行以红色开头：' + line);

// ============================================================ 6f. 狂骨
console.log('\n[6f] 狂骨：固定回 3 点血，只有概率随等级涨');
const kgDef = Enchants.byId('kuanggu');
eq(kgDef.name, '狂骨', '名字是狂骨');
eq(kgDef.maxLevel, 20, '最高 20 级');
eq(kgDef.chance.length, 20, '概率数组 20 档');
eq(kgDef.chance[0], 5, '1 级 5%');
eq(kgDef.chance[19], 100, '20 级 100%');
eq(kgDef.chance[5], 30, '6 级 30%');
eq(kgDef.params.heal, 3, '回血量固定 3 点');

// 1 级触发：10 点血 → 13 点
function makeHealPlayer(uuid, hp, maxHp, lore) {
    const p = makePlayer({ uuid: uuid, health: hp, maxHealth: maxHp || 20, hand: makeItem('minecraft:iron_sword', [lore]) });
    p.setHealth = function (n) { this.health = Number(n); return true; };
    return p;
}
const healer1 = makeHealPlayer('p-kg1', 10, 20, '狂骨1');
rt.cooldowns.clear();
rt.onMeleeHit(healer1, makeMob(50), 5, 2, RNG_HIT);
eq(healer1.health, 13, '1 级：10 → 13（+3 点）');

// 20 级也是 +3，不会变多
const healer20 = makeHealPlayer('p-kg20', 5, 20, '狂骨20');
rt.cooldowns.clear();
rt.onMeleeHit(healer20, makeMob(50), 5, 2, RNG_HIT);
eq(healer20.health, 8, '20 级：还是 +3 点（5 → 8）');

// 不超过血量上限
const healerCap = makeHealPlayer('p-kgcap', 19, 20, '狂骨10');
rt.cooldowns.clear();
rt.onMeleeHit(healerCap, makeMob(50), 5, 2, RNG_HIT);
eq(healerCap.health, 20, '回血不会超过最大生命（19 → 20）');

// 默认不发提示
const healerQuiet = makeHealPlayer('p-kgq', 10, 20, '狂骨3');
rt.cooldowns.clear();
healerQuiet.msgs.length = 0;
rt.onMeleeHit(healerQuiet, makeMob(50), 5, 2, RNG_HIT);
eq(healerQuiet.msgs.length, 0, '默认不给提示（params.announce=false）');

// 打开 announce 就提示
Config.current.enchants.kuanggu.params = Object.assign({}, Config.current.enchants.kuanggu.params, { announce: true });
const healerLoud = makeHealPlayer('p-kgl', 10, 20, '狂骨3');
rt.cooldowns.clear();
rt.onMeleeHit(healerLoud, makeMob(50), 5, 2, RNG_HIT);
ok(healerLoud.msgs.length === 1 && healerLoud.msgs[0].indexOf('狂骨') >= 0, '打开 announce 后有提示');
Config.current.enchants.kuanggu.params.announce = false;

// ============================================================ 6g. 斩绝
console.log('\n[6g] 斩绝：目标 ≤30% 血才斩杀，3% 起每级 +3%');
const cjDef = Enchants.byId('cleave');
eq(cjDef.name, '斩绝', '名字是斩绝');
eq(cjDef.maxLevel, 34, '最高 34 级（99% 在第 33 级，100% 在第 34 级）');
eq(cjDef.chance.length, 34, '概率数组 34 档');
eq(cjDef.chance[0], 3, '1 级 3%');
eq(cjDef.chance[1], 6, '2 级 6%');
eq(cjDef.chance[32], 99, '33 级 99%');
eq(cjDef.chance[33], 100, '34 级 100%');
eq(cjDef.params.healthRatio, 0.3, '斩杀门槛 30%');

function makeCjPlayer(uuid, lore) {
    return makePlayer({ uuid: uuid, hand: makeItem('minecraft:netherite_sword', [lore]) });
}

// 目标残血（10/100 = 10% ≤ 30%）→ 斩杀
const cjPlayer = makeCjPlayer('p-cj', '斩绝34');
const weakMob = makeMob(100);
weakMob.health = 10;
weakMob.maxHealth = 100;
rt.cooldowns.clear();
rt.onMeleeHit(cjPlayer, weakMob, 5, 2, RNG_HIT);
eq(weakMob.killCalls, 1, '残血目标被斩杀');

// 目标健康（50/100 = 50% > 30%）→ 不斩杀
const strongMob = makeMob(100);
strongMob.health = 50;
strongMob.maxHealth = 100;
rt.cooldowns.clear();
rt.onMeleeHit(cjPlayer, strongMob, 5, 2, RNG_HIT);
eq(strongMob.killCalls, 0, '健康目标不会被斩杀（就算 100% 概率）');

// 刚好 30% 的边界 → 斩杀（≤ 30%）
const edgeMob = makeMob(100);
edgeMob.health = 30;
edgeMob.maxHealth = 100;
rt.cooldowns.clear();
rt.onMeleeHit(cjPlayer, edgeMob, 5, 2, RNG_HIT);
eq(edgeMob.killCalls, 1, '刚好 30% 也算残血（≤ 判定）');

// 默认不发提示；打开后发
const loudMob = makeMob(100);
loudMob.health = 5;
loudMob.maxHealth = 100;
rt.cooldowns.clear();
cjPlayer.msgs.length = 0;
rt.onMeleeHit(cjPlayer, loudMob, 5, 2, RNG_HIT);
eq(cjPlayer.msgs.length, 1, '斩绝默认就播报（announce 默认 true）');
ok(cjPlayer.msgs[0].indexOf('斩绝') >= 0, '播报内容是斩绝');

// 关掉播报
Config.current.enchants.cleave.params = Object.assign({}, Config.current.enchants.cleave.params, { announce: false });
const quietMob = makeMob(100);
quietMob.health = 5;
quietMob.maxHealth = 100;
rt.cooldowns.clear();
cjPlayer.msgs.length = 0;
rt.onMeleeHit(cjPlayer, quietMob, 5, 2, RNG_HIT);
eq(cjPlayer.msgs.length, 0, '关掉 announce 后不播报');
Config.current.enchants.cleave.params.announce = true;

// ============================================================ 6h. 爆破
console.log('\n[6h] 爆破：优先原生爆炸（特效+击退），签名不对才兜底');
const blastDef = Enchants.byId('blast');
eq(blastDef.name, '爆破', '名字是爆破');
eq(blastDef.maxLevel, 20, '最高 20 级');
eq(blastDef.chance.length, 20, '概率 20 档');
eq(blastDef.chance[0], 5, '1 级 5%');
eq(blastDef.chance[19], 100, '20 级 100%');
eq(blastDef.params.destroy, false, '默认不破坏方块');
eq(blastDef.params.native, true, '默认优先原生爆炸（要原版特效和击退）');

// ① 服务器「6 参无效、5 参有效」→ 插件要能自己试出 5 参
const blaster = makePlayer({ uuid: 'p-blast', hand: makeItem('minecraft:netherite_sword', ['爆破5']) });
const bMob = makeMob(100);
global.__blastTarget = bMob;
global.__blastMode = 'fiveOnly';
explosions.length = 0;
bMob.hurtCalls.length = 0;
rt.cooldowns.clear();
rt.onMeleeHit(blaster, bMob, 5, 2, RNG_HIT);
ok(explosions.length >= 2, '试了不止一种签名（' + explosions.length + ' 次）');
ok(bMob.health < 100, '原生爆炸生效了（血量被扣）');
eq(bMob.hurtCalls.length, 0, '原生生效时不再重复自己算伤害');

// ② 服务器完全不支持 → 走兜底：范围内所有实体（包括自己）都掉血
const blaster2 = makePlayer({ uuid: 'p-blast2', hand: makeItem('minecraft:netherite_sword', ['爆破5']) });
const bMob2 = makeMob(100);
const selfP = blaster2;
global.__blastTarget = bMob2;
global.__blastMode = 'none';
global.__blastList = [bMob2, selfP];
explosions.length = 0;
runexCmds.length = 0;
bMob2.hurtCalls.length = 0;
selfP.hurtTaken = 0;
rt.cooldowns.clear();
rt.onMeleeHit(blaster2, bMob2, 5, 2, RNG_HIT);
ok(bMob2.hurtCalls.length >= 1, '兜底：目标被扣血');
ok(selfP.hurtTaken > 0, '兜底：自己也在范围内（会被炸到）');
ok(runexCmds.some((c) => c.indexOf('playsound') >= 0), '兜底也会播音效');

// ③ native=false 直接走兜底，不碰 mc.explode
Config.current.enchants.blast.params = Object.assign({}, Config.current.enchants.blast.params, { native: false });
const bMob3 = makeMob(100);
global.__blastTarget = bMob3;
global.__blastMode = 'fiveOnly';
global.__blastList = [bMob3];
explosions.length = 0;
rt.cooldowns.clear();
rt.onMeleeHit(blaster2, bMob3, 5, 2, RNG_HIT);
eq(explosions.length, 0, 'native=false 时不调 mc.explode');
ok(bMob3.hurtCalls.length >= 1, 'native=false 时仍会自己算伤害');
Config.current.enchants.blast.params.native = true;

// ④ 提示
Config.current.enchants.blast.params = Object.assign({}, Config.current.enchants.blast.params, { announce: true });
global.__blastMode = 'fiveOnly';
global.__blastTarget = makeMob(100);
rt.cooldowns.clear();
blaster2.msgs.length = 0;
rt.onMeleeHit(blaster2, global.__blastTarget, 5, 2, RNG_HIT);
ok(blaster2.msgs.length === 1 && blaster2.msgs[0].indexOf('爆破') >= 0, '打开 announce 后有提示');
Config.current.enchants.blast.params.announce = false;

// ============================================================ 6i. 混沌打击 / 完全混沌
console.log('\n[6i] 混沌打击（随机一个）/ 完全混沌（全来）');
const chaosDef = Enchants.byId('chaos');
const totalDef = Enchants.byId('chaos_total');
eq(chaosDef.name, '混沌打击', '名字是混沌打击');
eq(totalDef.name, '完全混沌', '名字是完全混沌');
eq(chaosDef.maxLevel, 10, '混沌打击最高 10 级');
eq(totalDef.maxLevel, 10, '完全混沌最高 10 级');
eq(chaosDef.chance, Enchants.byId('poison').chance, '混沌打击概率和淬毒一致');
eq(totalDef.chance, Enchants.byId('poison').chance, '完全混沌概率和淬毒一致');

// 混沌打击：rng=0 → 抽到第一个（雷神）
const cp = makePlayer({ uuid: 'p-chaos', hand: makeItem('minecraft:netherite_sword', ['混沌打击5']) });
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onMeleeHit(cp, makeMob(100), 5, 2, { rng: () => 0 });
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt') === 0), '混沌打击 rng=0 → 触发了雷神（闪电）');

// 混沌打击：第 1 次取随机数用于概率判定（0.4 → 通过 50%），第 2 次用于抽取（0.99 → 最后一个 = 掠袭）
const cm = makeMob(100);
rt.cooldowns.clear();
let seqCalls = 0;
rt.onMeleeHit(cp, cm, 5, 2, { rng: () => (seqCalls++ === 0 ? 0.4 : 0.99) });
ok(cm.effects.some((e) => e.id === 30), '混沌打击抽到掠袭（黑暗 id 30）');

// 完全混沌：7 个效果全来（雷神 + 6 个状态）
const tp = makePlayer({ uuid: 'p-total', hand: makeItem('minecraft:netherite_sword', ['完全混沌5']) });
const tm = makeMob(100);
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onMeleeHit(tp, tm, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt') === 0), '完全混沌：雷神也触发了');
const ids = tm.effects.map((e) => e.id);
for (const expect of [20, 15, 17, 2, 24, 30]) {
    ok(ids.indexOf(expect) >= 0, '完全混沌：带上了效果 id ' + expect);
}
eq(ids.length, 6, '完全混沌：一共挂了 6 个状态效果（另一个是雷神）');

// 混沌类自己不会刷屏（子效果被静音，混沌本身默认也不播报）
const quiet = makePlayer({ uuid: 'p-quiet', hand: makeItem('minecraft:netherite_sword', ['完全混沌5']) });
rt.cooldowns.clear();
quiet.msgs.length = 0;
rt.onMeleeHit(quiet, makeMob(100), 5, 2, RNG_HIT);
eq(quiet.msgs.length, 0, '混沌类默认不刷屏');

// ============================================================ 6j. 护甲「领域」系列
console.log('\n[6j] 护甲领域：挨打时把效果打到攻击者身上');
const auraNames = [
    ['雷之领域', 'aura_thunder'],
    ['死亡领域', 'aura_wither'],
    ['侵袭之域', 'aura_blind'],
    ['荒芜领域', 'aura_famine'],
    ['寒冰领域', 'aura_chill'],
    ['苍空领域', 'aura_ascend'],
    ['掠袭领域', 'aura_raid'],
];
for (const pair of auraNames) {
    const d = Enchants.byKey(pair[0]);
    ok(d != null && d.id === pair[1], '「' + pair[0] + '」解析成 ' + pair[1]);
    eq(d.maxLevel, 10, pair[0] + ' 最高 10 级');
    eq(d.trigger, 'hurt', pair[0] + ' 触发点是受伤');
    eq(d.slot, 'armor', pair[0] + ' 适用护甲');
}

// ① 死亡领域：穿胸甲挨打 → 攻击者凋零
const chestAura = makeItem('minecraft:netherite_chestplate', ['死亡领域4']);
const victimA = makePlayer({ uuid: 'p-aura1', armor: [null, chestAura, null, null] });
const attacker = makeMob(100);
rt.cooldowns.clear();
rt.onPlayerHurt(victimA, attacker, 5, 2, RNG_HIT);
ok(attacker.effects.some((e) => e.id === 20 && e.amp === 4), '死亡领域：攻击者中了凋零 IV（id 20, amp 4）');

// ② 寒冰领域：鞘翅也能触发
const elytra = makeItem('minecraft:elytra', ['寒冰领域3']);
const victimB = makePlayer({ uuid: 'p-aura2', armor: [null, elytra, null, null] });
const attacker2 = makeMob(100);
rt.cooldowns.clear();
rt.onPlayerHurt(victimB, attacker2, 5, 2, RNG_HIT);
ok(attacker2.effects.some((e) => e.id === 2 && e.amp === 3), '寒冰领域：攻击者中了缓慢（id 2），鞘翅算护甲');

// ③ 侵袭之域：头颅也能触发
const skull = makeItem('minecraft:skull', ['侵袭之域2']);
const victimC = makePlayer({ uuid: 'p-aura3', armor: [skull, null, null, null] });
const attacker3 = makeMob(100);
rt.cooldowns.clear();
rt.onPlayerHurt(victimC, attacker3, 5, 2, RNG_HIT);
ok(attacker3.effects.some((e) => e.id === 15 && e.amp === 2), '侵袭之域：攻击者失明（id 15），头颅算护甲');

// ④ 荒芜领域：固定 255 级
const chestFamine = makeItem('minecraft:diamond_chestplate', ['荒芜领域9']);
const victimD = makePlayer({ uuid: 'p-aura4', armor: [null, chestFamine, null, null] });
const attacker4 = makeMob(100);
rt.cooldowns.clear();
rt.onPlayerHurt(victimD, attacker4, 5, 2, RNG_HIT);
ok(attacker4.effects.some((e) => e.id === 17 && e.amp === 254), '荒芜领域：饥饿 amp=254（显示 255），不随等级变');

// ⑤ 雷之领域：在攻击者位置召唤闪电
const chestThunder = makeItem('minecraft:diamond_chestplate', ['雷之领域5']);
const victimE = makePlayer({ uuid: 'p-aura5', armor: [null, chestThunder, null, null] });
const attacker5 = makeMob(100);
attacker5.pos = { x: 33.5, y: 70, z: -12.5 };
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onPlayerHurt(victimE, attacker5, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt 33.5 70.0 -12.5') === 0),
    '雷之领域：闪电落在攻击者位置（' + runexCmds.join(' | ') + '）');

// ⑥ 没穿护甲就不触发
const bareVictim = makePlayer({ uuid: 'p-aura6', armor: [null, null, null, null] });
const attacker6 = makeMob(100);
rt.cooldowns.clear();
rt.onPlayerHurt(bareVictim, attacker6, 5, 2, RNG_HIT);
eq(attacker6.effects.length, 0, '没穿护甲不会触发领域');

// ⑦ 概率和武器同名词条一致
eq(Enchants.byId('aura_chill').chance, Enchants.byId('chill').chance, '寒冰领域概率 = 冰冻概率');
eq(Enchants.byId('aura_raid').chance, Enchants.byId('raid').chance, '掠袭领域概率 = 掠袭概率');
eq(Enchants.byId('aura_thunder').chance, Enchants.byId('thunder').chance, '雷之领域概率 = 雷神概率');

// ============================================================ 6k. 混沌领域 / 终焉混沌
console.log('\n[6k] 混沌领域（随机一个）/ 终焉混沌（全来），都打到攻击者');
const auraChaos = Enchants.byId('aura_chaos');
const auraTotal = Enchants.byId('aura_chaos_total');
eq(auraChaos.name, '混沌领域', '名字是混沌领域');
eq(auraTotal.name, '终焉混沌', '名字是终焉混沌');
eq(auraChaos.trigger, 'hurt', '混沌领域：受伤触发');
eq(auraTotal.trigger, 'hurt', '终焉混沌：受伤触发');
eq(auraChaos.slot, 'armor', '混沌领域：适用护甲');
eq(auraTotal.slot, 'armor', '终焉混沌：适用护甲');
eq(auraChaos.chance, Enchants.byId('chaos').chance, '混沌领域概率 = 混沌打击概率');
eq(auraTotal.chance, Enchants.byId('chaos_total').chance, '终焉混沌概率 = 完全混沌概率');

// 混沌领域：概率判定 0.4（过），抽取 0.99 → 掠袭 → 攻击者黑暗
const chestChaos = makeItem('minecraft:netherite_chestplate', ['混沌领域5']);
const victimK = makePlayer({ uuid: 'p-aura-chaos', armor: [null, chestChaos, null, null] });
const atkK = makeMob(100);
rt.cooldowns.clear();
let kCalls = 0;
rt.onPlayerHurt(victimK, atkK, 5, 2, { rng: () => (kCalls++ === 0 ? 0.4 : 0.99) });
ok(atkK.effects.some((e) => e.id === 30), '混沌领域抽到掠袭 → 攻击者黑暗');

// 终焉混沌：7 个全来（雷神 + 6 个状态）
const chestTotal = makeItem('minecraft:netherite_chestplate', ['终焉混沌5']);
const victimT = makePlayer({ uuid: 'p-aura-total', armor: [null, chestTotal, null, null] });
const atkT = makeMob(100);
atkT.pos = { x: 7.5, y: 66, z: 7.5 };
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onPlayerHurt(victimT, atkT, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt 7.5 66.0 7.5') === 0),
    '终焉混沌：闪电落在攻击者位置');
const tIds = atkT.effects.map((e) => e.id);
for (const expect of [20, 15, 17, 2, 24, 30]) {
    ok(tIds.indexOf(expect) >= 0, '终焉混沌：攻击者带上了效果 id ' + expect);
}
eq(tIds.length, 6, '终焉混沌：共 6 个状态 + 1 次闪电');

// 默认不刷屏
const quietV = makePlayer({ uuid: 'p-aura-quiet', armor: [null, makeItem('minecraft:iron_chestplate', ['终焉混沌5']), null, null] });
rt.cooldowns.clear();
quietV.msgs.length = 0;
rt.onPlayerHurt(quietV, makeMob(100), 5, 2, RNG_HIT);
eq(quietV.msgs.length, 0, '终焉混沌默认不刷屏');

// ============================================================ 6l. 跨维度闪电
console.log('\n[6l] 下界/末地的闪电要用 execute in 指定维度');
const dimPlayer = makePlayer({ uuid: 'p-dim', hand: makeItem('minecraft:netherite_sword', ['雷神5']) });

// 主世界：普通 summon
const wMob = makeMob(100);
wMob.pos = { x: 1, y: 64, z: 2, dimid: 0 };
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onMeleeHit(dimPlayer, wMob, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt 1.0 64.0 2.0') === 0),
    '主世界：直接 summon（' + runexCmds.join(' | ') + '）');

// 下界
const nMob = makeMob(100);
nMob.pos = { x: 5, y: 40, z: -8, dimid: 1 };
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onMeleeHit(dimPlayer, nMob, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('execute in nether run summon minecraft:lightning_bolt 5.0 40.0 -8.0') === 0),
    '下界：execute in nether（' + runexCmds.join(' | ') + '）');

// 末地
const eMob = makeMob(100);
eMob.pos = { x: 0, y: 70, z: 0, dimid: 2 };
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onMeleeHit(dimPlayer, eMob, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('execute in the_end run summon minecraft:lightning_bolt 0.0 70.0 0.0') === 0),
    '末地：execute in the_end（' + runexCmds.join(' | ') + '）');

// 雷之领域也要按攻击者所在维度
const auraChest = makeItem('minecraft:netherite_chestplate', ['雷之领域5']);
const auraVictim = makePlayer({ uuid: 'p-dim-aura', armor: [null, auraChest, null, null] });
const nAttacker = makeMob(100);
nAttacker.pos = { x: 9, y: 33, z: 9, dimid: 1 };
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onPlayerHurt(auraVictim, nAttacker, 5, 2, RNG_HIT);
ok(runexCmds.some((c) => c.indexOf('execute in nether run summon minecraft:lightning_bolt 9.0 33.0 9.0') === 0),
    '雷之领域：也按攻击者维度执行（' + runexCmds.join(' | ') + '）');

// ============================================================ 6m. summon 被拒 → 模拟落雷
console.log('\n[6m] 服务器拒绝 summon 时自动模拟落雷');
const realRuncmdEx = global.mc.runcmdEx;
const realRuncmd = global.mc.runcmd;
const realExplode = global.mc.explode;

// 让所有 summon 都失败（模拟「Unable to summon object」）
global.mc.runcmdEx = (c) => (String(c).indexOf('summon') >= 0
    ? { success: false, output: 'Unable to summon object' }
    : { success: true, output: '' });
global.mc.runcmd = (c) => (String(c).indexOf('summon') >= 0 ? false : true);

const fakeExplodes = [];
global.mc.explode = (pos, src, maxRes, radius, isDestroy, isFire) => {
    fakeExplodes.push({ pos: pos, radius: radius, destroy: isDestroy });
    return true;
};

const fakeP = makePlayer({ uuid: 'p-fake-light', hand: makeItem('minecraft:netherite_sword', ['雷神5']) });
const fakeMob = makeMob(100);
fakeMob.pos = { x: 12, y: 66, z: 12 };
rt.cooldowns.clear();
fakeExplodes.length = 0;
rt.onMeleeHit(fakeP, fakeMob, 5, 2, RNG_HIT);

ok(fakeExplodes.length >= 1, 'summon 全失败 → 走了模拟落雷（调用了 mc.explode）');
eq(fakeExplodes[0].destroy, false, '模拟落雷不破坏方块');
eq(fakeExplodes[0].radius, 2.5, '模拟爆炸半径 2.5');
ok(fakeExplodes[0].pos.x === 12 && fakeExplodes[0].pos.y === 66, '爆炸落在目标坐标');

// 爆炸也不可用 → 至少要有伤害
global.mc.explode = null;
const fakeP2 = makePlayer({ uuid: 'p-fake-light2', hand: makeItem('minecraft:netherite_sword', ['雷神5']) });
const fakeMob2 = makeMob(100);
fakeMob2.pos = { x: 3, y: 60, z: 3 };
rt.cooldowns.clear();
fakeMob2.hurtCalls.length = 0;
rt.onMeleeHit(fakeP2, fakeMob2, 5, 2, RNG_HIT);
ok(fakeMob2.hurtCalls.length >= 1, '连爆炸都没有时，直接对目标扣血兜底');

// 恢复桩
global.mc.runcmdEx = realRuncmdEx;
global.mc.runcmd = realRuncmd;
global.mc.explode = realExplode;
global.mc.getEntities = global.mc.getEntities;

// ============================================================ 6n. 维度未知（-1）→ 三种维度都试
console.log('\n[6n] 拿不到维度时：三个维度都试一遍');
const noDimMob = makeMob(100);
noDimMob.pos = { x: 2, y: 64, z: 2 };     // 没有 dimid → targetDim 返回 -1
const noDimP = makePlayer({ uuid: 'p-nodim', hand: makeItem('minecraft:netherite_sword', ['雷神5']) });
rt.cooldowns.clear();
runexCmds.length = 0;
rt.onMeleeHit(noDimP, noDimMob, 5, 2, RNG_HIT);
eq(runexCmds.length, 1, '第一发就成功（主世界直接 summon），不会继续乱试');
ok(runexCmds[0].indexOf('summon minecraft:lightning_bolt') === 0, '先试主世界 summon');

// ============================================================ 7. 配置
console.log('\n[7] 配置');
const cfg = Config.get();
ok(cfg.enchants.thunder != null, '配置里生成了 thunder');
eq(cfg.enchants.thunder.chance, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], '默认概率数组（每级 10%，共 10 级）');
eq(Enchants.LIST.length, 23, '本版有 23 个词条（14 武器 + 9 护甲）');
ok(Enchants.byId('poison') != null, '淬毒已注册');

ok(Enchants.byId('wither') != null, '死亡已注册');
ok(Enchants.byId('lifesteal') == null, '吸血等词条仍未加');
ok(Enchants.hasPassive() === false, '没有常驻词条 → 不起定时器');

// ============================================================ 7. 配置迁移
console.log('\n[8] 老配置迁移（触发提示改为默认关闭）');
files.set('config/lore_enchant/config.json', JSON.stringify({
    enabled: true,
    announce_triggers: true,    // v1~v3 时代写死在文件里的值
    enchants: { thunder: { enabled: true, chance: [15, 30, 45, 60, 75, 90, 100], cooldown_ms: 0 } },
}));
Config.load();
eq(Config.get().announce_triggers, false, '老配置里的 announce_triggers:true 被迁移成 false（v4 默认关闭）');
eq(Config.get().config_version, 5, 'config_version 升到最新版');

// ============================================================ 8. 概率数组迁移
console.log('\n[9] 老配置的概率数组刷新 + v4 迁移');
files.set('config/lore_enchant/config.json', JSON.stringify({
    config_version: 2,
    enabled: true,
    announce_triggers: true,
    // 旧默认值：只有 5 档，且冷却 200ms
    enchants: { thunder: { enabled: true, chance: [5, 12.5, 20, 27.5, 35], cooldown_ms: 200 } },
}));
Config.load();
const c2 = Config.forEnchant('thunder');
eq(c2.chance.length, 10, '旧 5 档数组被刷新成 10 档');
eq(c2.chance, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100], '刷新成新默认概率（每级 10%）');
eq(c2.cooldown_ms, 0, '冷却一起刷成默认值（0 = 不防连点，保证 7 级必出）');
eq(Config.get().config_version, 5, 'config_version 升到最新版');

// 长度一致时不动（认为管理员自己调过，尊重他的手感）
files.set('config/lore_enchant/config.json', JSON.stringify({
    config_version: 2,
    enabled: true,
    announce_triggers: true,
    enchants: { thunder: { enabled: true, chance: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50], cooldown_ms: 500 } },
}));
Config.load();
const c3 = Config.forEnchant('thunder');
eq(c3.chance[0], 50, '长度一致的数组不会被覆盖（管理员的调参保留）');
eq(c3.cooldown_ms, 500, '冷却也不会被覆盖');

// ============================================================ 9. 落地到物品
console.log('\n[10] applyToHeld：改 lore + 写回容器 + refreshItems');
const loreedit = require('plugins/lore_enchant/src/loreedit');

function makeHolder(opts) {
    const o = opts || {};
    const item = {
        type: 'minecraft:netherite_sword',
        name: '剑',
        lore: (o.lore || []).slice(),
        setLore(arr) { this.lore = arr.slice(); return true; },
    };
    const inv = {
        items: {},
        getItem(slot) { return this.items[slot] || item; },
        setItem(slot, it) { this.items[slot] = it; return true; },
    };
    const p = {
        uuid: 'holder-1',
        selectedSlot: 3,
        _item: item,
        refreshCount: 0,
        getHand() { return item; },
        getInventory() { return inv; },
        refreshItems() { this.refreshCount++; return true; },
        isOP() { return true; },
    };
    return p;
}

const holder = makeHolder();
const r1 = loreedit.applyToHeld(holder, Enchants.byId('thunder'), 4);
eq(r1.ok, true, 'applyToHeld 返回成功');
ok((r1.paths || []).join(',').indexOf('inventory.setItem') >= 0, '写回走了 inventory.setItem');
ok(holder.refreshCount > 0, '调用了 refreshItems（否则客户端不刷新）');
eq(gear.enchantsOf(holder._item, Config.get()).get('thunder'), 4, '写完能解析出 4 级');

// 再附一次不同等级 → 替换而不是叠加
const r2 = loreedit.applyToHeld(holder, Enchants.byId('thunder'), 7);
eq(r2.ok, true, '第二次附魔成功');
eq(holder._item.lore.filter((l) => l.indexOf('雷神') >= 0).length, 1, 'lore 里仍然只有一行雷神');
eq(gear.enchantsOf(holder._item, Config.get()).get('thunder'), 7, '等级被替换成 7');

// 没有容器/没有 selectedSlot 的玩家 → 退回 getHand 路径
const bareHolder = {
    uuid: 'holder-2',
    _item: { type: 'minecraft:iron_sword', name: '剑', lore: [], setLore(a) { this.lore = a.slice(); return true; } },
    getHand() { return this._item; },
    setHand() { return true; },
    isOP() { return true; },
};
const r3 = loreedit.applyToHeld(bareHolder, Enchants.byId('thunder'), 2);
eq(r3.ok, true, '没有容器时也能写（退回 getHand）');
eq(r3.via, 'hand', 'via = hand（说明走的是兜底路径）');

// ============================================================ 11. 一键清除
console.log('\n[11] 一键清除：删词条行，保留其它 lore');
const clearHolder = makeHolder();
clearHolder._item.lore = ['§b雷神 §fIII', '§7普通说明', '§c死亡领域 §fII', '§8再一行普通文字'];
const clearR = loreedit.clearAllEnchants(clearHolder);
eq(clearR.ok, true, '清除成功');
eq(clearR.removed, 2, '移除了 2 个词条行');
eq(clearR.kept, 2, '保留了 2 行其它 lore');
const left = clearHolder._item.lore.join('|');
ok(left.indexOf('雷神') < 0 && left.indexOf('死亡领域') < 0, '词条行都没了');
ok(left.indexOf('普通说明') >= 0 && left.indexOf('再一行') >= 0, '普通行还在');

// 没有词条时给提示、不改物品
const emptyHolder = makeHolder();
emptyHolder._item.lore = ['§7只有普通文字'];
const clearR2 = loreedit.clearAllEnchants(emptyHolder);
eq(clearR2.ok, false, '没词条时返回失败');
eq(clearR2.removed, 0, '没移除任何行');
ok(emptyHolder._item.lore.join('|').indexOf('只有普通文字') >= 0, '物品没被改动');

// ============================================================ 汇总
console.log('\n============================');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
    console.log('失败清单：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
}
console.log('全部通过 ✅');
