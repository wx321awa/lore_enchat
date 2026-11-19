"use strict";
/**
 * 冒烟测试（词条版）：假装成一个 LSE 环境，把 index.js 真跑一遍。
 *
 *     node test/smoke-index.js
 *
 * 抓的是「接线错误」：语法错、require 路径错、命令注册写错、事件回调写错、
 * 以及 Node 有而 QuickJS 没有的语法（用静态扫描挡）。
 */
const path = require('path');
const Module = require('module');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    const m = /^plugins\/lore_enchant\/(.*)$/.exec(request);
    if (m) return origLoad.call(this, path.join(ROOT, m[1] + '.js'), parent, isMain);
    return origLoad.call(this, request, parent, isMain);
};

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

// ---------------------------------------------------------- 静态检查
// QuickJS 和 Node 有行为差异：箭头函数里没有 arguments、没有 process / node: 模块。
// 线上真踩过：处理器第一行用 arguments.length → ReferenceError → 全部词条失效。
console.log('\n[0] 静态检查（QuickJS 兼容性）');
function listJs(dir) {
    const out = [];
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) out.push(...listJs(p));
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}
function stripComments(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split(/\r?\n/)
        .map((ln) => ln.replace(/\/\/.*$/, ''))
        .join('\n');
}
const pluginFiles = [path.join(ROOT, 'index.js')].concat(listJs(path.join(ROOT, 'src')));
for (const file of pluginFiles) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file);
    ok(!/\barguments\b/.test(code), rel + ' 没有用 arguments');
    ok(!/\bprocess\s*\./.test(code), rel + ' 没有用 process');
    ok(!/\brequire\(\s*['"]node:/.test(code), rel + ' 没有 require node: 模块');
    ok(!/\bglobalThis\b/.test(code), rel + ' 没有用 globalThis');
}

// ---------------------------------------------------------- LSE 全局桩
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

global.PermType = { Any: 0, GameMasters: 1, Console: 2 };
global.ParamType = { Enum: 'enum', String: 'string', Int: 'int' };

const runcmds = [];      // mc.runcmd（会打屏，不该用）
const runexCmds = [];    // mc.runcmdEx（隐藏输出）
const listeners = new Map();
let registeredCommand = null;
const allCommands = {};
const intervals = [];

global.mc = {
    runcmd: (c) => { runcmds.push(String(c)); return true; },
    runcmdEx: (c) => { runexCmds.push(String(c)); return { success: true, output: '' }; },
    getOnlinePlayers: () => [],
    listen: (ev, cb) => { listeners.set(ev, cb); return true; },

    // 表单：把构造出来的表单记下来，测试里手动触发回调
    newSimpleForm: () => {
        const f = {
            kind: 'simple', title: '', content: '', buttons: [],
            setTitle(t) { this.title = t; return this; },
            setContent(c) { this.content = c; return this; },
            addButton(t) { this.buttons.push(String(t)); return this; },
        };
        return f;
    },
    newCustomForm: () => {
        const f = {
            kind: 'custom', title: '', content: '', sliders: [],
            setTitle(t) { this.title = t; return this; },
            setContent(c) { this.content = c; return this; },
            addSlider(title, min, max, stepArg, defVal) {
                this.sliders.push({ title, min, max, step: stepArg, def: defVal });
                return this;
            },
        };
        return f;
    },
    newCommand: (name) => {
        const cmd = {
            name, enums: {}, args: [], overloads: [], callback: null,
            setEnum(n, v) { this.enums[n] = v; return this; },
            mandatory(n, t, e) { this.args.push({ n, t, e }); return this; },
            optional(n, t, e) { this.args.push({ n, t, e }); return this; },
            overload(l) { this.overloads.push(l); return this; },
            setCallback(cb) { this.callback = cb; return this; },
            setup() { registeredCommand = this; allCommands[this.name] = this; return true; },
        };
        return cmd;
    },
};

global.ll = { registerPlugin: () => true, onUnload: (cb) => { global.__unload = cb; return true; } };

const realSetInterval = global.setInterval;
global.setInterval = (cb, ms) => {
    intervals.push({ cb, ms });
    const t = realSetInterval(cb, 60 * 60 * 1000);
    if (typeof t.unref === 'function') t.unref();
    return t;
};

// ---------------------------------------------------------- 加载 index.js
console.log('\n[1] 加载 index.js');
let bootError = null;
try {
    require(path.join(ROOT, 'index.js'));
} catch (e) {
    bootError = e;
}
ok(bootError == null, 'index.js 能加载' + (bootError ? '：' + bootError.stack : ''));

console.log('\n[2] 命令注册');
ok(allCommands['le'] != null, '注册了 /le 命令');
ok(allCommands['le'] && allCommands['le'].name === 'le', '命令名是 le');
ok(allCommands['le'] && allCommands['le'].callback != null, '命令有回调');

console.log('\n[3] 事件监听');
ok(listeners.has('onAttackEntity'), '监听了 onAttackEntity（近战主路径）');
ok(listeners.has('onMobHurt'), '监听了 onMobHurt（只做诊断）');
ok(listeners.has('onProjectileCreated'), '监听了 onProjectileCreated');
ok(listeners.has('onServerStarted'), '监听了 onServerStarted');

console.log('\n[4] 定时器');
ok(intervals.length === 0, '没有常驻词条 → 不起定时器（本版只有雷神）');

console.log('\n[5] 端到端：onAttackEntity 触发雷神');
const sword = { type: 'minecraft:netherite_sword', name: '剑', lore: ['雷神III'], count: 1 };
const player = {
    uuid: 'tester-1', name: 'T1', pos: { x: 0, y: 64, z: 0 }, health: 20, maxHealth: 20,
    msgs: [], tell(t) { this.msgs.push(String(t)); return true; },
    heal() { return true; }, addEffect() { return true; }, isPlayer() { return true; },
    getHand() { return sword; }, getOffHand() { return null; },
    getArmor() { return { getAllItems: () => [] }; }, isOP() { return true; },
};
const mob = {
    id: 'mob-1', name: 'Zombie', health: 20, maxHealth: 20, pos: { x: 5, y: 64, z: 5 },
    isPlayer() { return false; }, hurt() { return true; },
};

const realRandom = Math.random;
Math.random = () => 0;
runexCmds.length = 0;
runcmds.length = 0;
let ret = null;
try {
    ret = listeners.get('onAttackEntity')(player, mob);
} catch (e) {
    console.log('  ✗ onAttackEntity 抛错: ' + e.stack);
    failures.push('onAttackEntity 抛错');
}
Math.random = realRandom;

ok(ret === true, 'onAttackEntity 返回 true（不拦截）');
ok(runexCmds.some((c) => c.indexOf('summon minecraft:lightning_bolt') === 0), '雷神真的召唤了闪电（runcmdEx）');
ok(runcmds.length === 0, '没有用会打屏的 mc.runcmd（控制台不再刷 Object successfully summoned）');
ok(player.msgs.length === 0, '默认不给玩家发提示（announce_triggers 默认关闭）');

console.log('\n[6] 冷却');
// 本版默认 cooldown_ms = 0（7 级 100% 要保证每下都出）；这里临时给个冷却再验证机制
const cfgMod = require('plugins/lore_enchant/src/config');
cfgMod.Config.current.enchants.thunder.cooldown_ms = 200;
Math.random = () => 0;
runexCmds.length = 0;
listeners.get('onAttackEntity')(player, mob);
const firstCount = runexCmds.length;
runexCmds.length = 0;
listeners.get('onAttackEntity')(player, mob);
const secondCount = runexCmds.length;
Math.random = realRandom;
ok(firstCount === 1, '配了冷却后，第一次照常触发');
ok(secondCount === 0, '冷却期内第二次不触发');
cfgMod.Config.current.enchants.thunder.cooldown_ms = 0;

console.log('\n[7] onMobHurt 只做诊断');
Math.random = () => 0;
runcmds.length = 0;
try {
    listeners.get('onMobHurt')(mob, { type: 'minecraft:player' }, 5, 2);
} catch (e) {
    console.log('  ✗ onMobHurt 抛错: ' + e.stack);
}
Math.random = realRandom;
ok(runcmds.length === 0, 'onMobHurt 不再触发词条（避免和 onAttackEntity 重复）');
ok(logs.some((l) => l.indexOf('onMobHurt #1') >= 0), 'onMobHurt 打了诊断日志（含参数类型）');

console.log('\n[8] /le 雷神 3 快捷附魔');
function makeOut() {
    const o = {
        ok: [], err: [],
        success(m) { o.ok.push(String(m)); },
        error(m) { o.err.push(String(m)); },
    };
    return o;
}
function makeEnchantPlayer(opts) {
    const o = opts || {};
    const item = {
        type: o.type || 'minecraft:netherite_sword',
        name: '剑',
        lore: [],
        setLore(arr) { this.lore = arr.slice(); return true; },
    };
    const inv = {
        items: {},
        getItem(slot) { return this.items[slot] || item; },
        setItem(slot, it) { this.items[slot] = it; return true; },
    };
    return {
        uuid: o.uuid || 'ench-1',
        name: 'Enchanter',
        selectedSlot: 0,
        _item: item,
        _inv: inv,
        _form: null,
        _cb: null,
        refreshCount: 0,
        getHand() { return item; },
        getOffHand() { return null; },
        getInventory() { return inv; },
        getArmor() { return { getAllItems: () => [] }; },
        isOP() { return o.op !== false; },
        msgs: [],
        tell(m) { this.msgs.push(String(m)); return true; },
        refreshItems() { this.refreshCount++; return true; },
        sendForm(fm, cb) { this._form = fm; this._cb = cb; return 1; },
    };
}
const cmdCb = allCommands['le'].callback;

// ① OP + 剑 + 等级 3
const ep = makeEnchantPlayer({});
let out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: '雷神', level: 3 });
ok(out.ok.length === 1, '写了成功提示（' + out.ok.join('|') + '）');
ok(ep._item.lore.some((l) => l.indexOf('雷神') >= 0), 'lore 里出现了「雷神」');
ok(ep._item.lore.join('').indexOf('III') >= 0, '等级写成罗马数字 III');

// ② 重复附魔 + 英文 id + 不给等级（默认 1 级）→ 应该只有一行
out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: 'thunder', level: null });
ok(ep._item.lore.filter((l) => l.indexOf('雷神') >= 0).length === 1, '重复附魔是替换，不会留两行');

// ③ 超过上限
out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: '雷神', level: 99 });
ok(out.ok.join('').indexOf('超过上限') >= 0, '超过上限时提示并按 7 级处理');
ok(ep._item.lore.join('').indexOf('X') >= 0, 'lore 里是 X（10 级）');

// ④ 非 OP
const np = makeEnchantPlayer({ op: false, uuid: 'nop' });
out = makeOut();
cmdCb(null, { player: np }, out, { pfx: '雷神', level: 1 });
ok(out.err.length === 1 && out.err[0].indexOf('OP') >= 0, '非 OP 被拒绝');

// ⑤ 槽位不对（弓）
const bp = makeEnchantPlayer({ type: 'minecraft:bow', uuid: 'bowp' });
out = makeOut();
cmdCb(null, { player: bp }, out, { pfx: '雷神', level: 1 });
ok(out.err.length === 1 && out.err[0].indexOf('只能用在') >= 0, '弓上附雷神被拒绝');

// ⑥ 不存在的词条
out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: '不存在的词条', level: 1 });
ok(out.err.length === 1 && out.err[0].indexOf('没有这个词条') >= 0, '不存在的词条被拒绝');

// ⑦ 淬毒也能通过命令附上
out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: '淬毒', level: 5 });
ok(out.ok.join('').indexOf('淬毒V') >= 0, '/le 淬毒 5 能写入（' + out.ok.join('') + '）');
ok(ep._item.lore.join('').indexOf('淬毒') >= 0, 'lore 里出现「淬毒」');
ok(ep._item.lore.filter((l) => l.indexOf('淬毒') >= 0).length === 1, '淬毒只有一行');

out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: '死亡', level: 3 });
ok(out.ok.join('').indexOf('死亡III') >= 0, '/le 死亡 3 能写入（' + out.ok.join('') + '）');

out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: '侵袭', level: 2 });
ok(out.ok.join('').indexOf('侵袭II') >= 0, '/le 侵袭 2 能写入（' + out.ok.join('') + '）');

out = makeOut();
cmdCb(null, { player: ep }, out, { pfx: 'XiYingKill', level: 2 });
ok(out.ok.join('').indexOf('XiYingKill') >= 0, '/le XiYingKill 2 能写入（' + out.ok.join('') + '）');

console.log('\n[8b] 护甲领域：onMobHurt → 打到攻击者');
// 玩家穿一件带「死亡领域3」的胸甲，被攻击 → 攻击者应该吃到凋零(20, amp3)
const chest = { type: 'minecraft:netherite_chestplate', name: '胸甲', lore: ['死亡领域3'], count: 1 };
const armored = makeEnchantPlayer({ uuid: 'armor-1' });
armored.getArmor = () => ({ getAllItems: () => [null, chest, null, null] });
const hitter = {
    id: 'hitter-1', name: 'Ravager', pos: { x: 2, y: 64, z: 2 }, health: 50, maxHealth: 50,
    effects: [],
    isPlayer() { return false; },
    addEffect(id, ticks, amp) { this.effects.push({ id, ticks, amp }); return true; },
};

Math.random = () => 0;
let hurtRet = null;
try {
    hurtRet = listeners.get('onMobHurt')(armored, hitter, 4, 2);
} catch (e) {
    console.log('  ✗ onMobHurt(护甲) 抛错: ' + e.stack);
    failures.push('onMobHurt 护甲抛错');
}
Math.random = realRandom;

ok(hurtRet === true, 'onMobHurt 不拦截普通伤害（返回 true）');
ok(hitter.effects.some((e) => e.id === 20 && e.amp === 3),
    '护甲领域生效：攻击者中了凋零 amp=3（实际：' + JSON.stringify(hitter.effects) + '）');

// 没穿护甲就不该触发
const bare = makeEnchantPlayer({ uuid: 'armor-2' });
bare.getArmor = () => ({ getAllItems: () => [] });
const hitter2 = { id: 'hitter-2', name: 'Zombie', pos: { x: 0, y: 64, z: 0 }, effects: [], isPlayer() { return false; }, addEffect(id) { this.effects.push({ id }); return true; } };
Math.random = () => 0;
listeners.get('onMobHurt')(bare, hitter2, 4, 2);
Math.random = realRandom;
ok(hitter2.effects.length === 0, '没穿护甲不会触发领域');

console.log('\n[8c] 跨维度闪电（下界/末地）');
const dimP = {
    uuid: 'dim-1', name: 'DimT', pos: { x: 0, y: 64, z: 0 }, health: 20, maxHealth: 20,
    dimid: 1, msgs: [],
    tell(m) { this.msgs.push(String(m)); return true; },
    isPlayer() { return true; },
    getHand() { return { type: 'minecraft:netherite_sword', name: '剑', lore: ['雷神5'], count: 1 }; },
    getOffHand() { return null; },
    getArmor() { return { getAllItems: () => [] }; },
};
const dimMob = { id: 'dm', name: 'Piglin', health: 20, maxHealth: 20, pos: { x: 4, y: 50, z: 4, dimid: 1 }, isPlayer() { return false; }, hurt() { return true; }, addEffect() { return true; }, kill() { return true; } };
Math.random = () => 0;
runexCmds.length = 0;
listeners.get('onAttackEntity')(dimP, dimMob);
Math.random = realRandom;
ok(runexCmds.some((c) => c.indexOf('execute in nether run summon minecraft:lightning_bolt 4.0 50.0 4.0') === 0),
    '下界攻击时用 execute in nether（' + runexCmds.join(' | ') + '）');

console.log('\n[9] /legui：主菜单 → 武器/护甲 → 词条 → 等级');
const legui = allCommands['legui'];
ok(legui != null, '注册了 /legui 命令');

const gp = makeEnchantPlayer({ uuid: 'gui-1' });
let gOut = makeOut();
legui.callback(null, { player: gp }, gOut);

// ① 主菜单：两个分类按钮
ok(gp._form != null && gp._form.kind === 'simple', '弹出主菜单');
eq(gp._form.buttons.length, 3, '主菜单有武器/护甲/一键清除 三个按钮');
ok(gp._form.buttons[0].indexOf('武器') >= 0, '第 1 个按钮是武器：' + gp._form.buttons[0]);
ok(gp._form.buttons[1].indexOf('护甲') >= 0, '第 2 个按钮是护甲：' + gp._form.buttons[1]);
ok(gp._form.buttons[2].indexOf('清除') >= 0, '第 3 个按钮是一键清除：' + gp._form.buttons[2]);
ok(gp._form.content.indexOf('v') >= 0, '主菜单写了版本号');

// ② 进武器子菜单
gp._cb(gp, 0);
ok(gp._form.kind === 'simple', '武器子菜单是按钮列表');
ok(gp._form.buttons.length >= 14, '武器分类列了 ' + gp._form.buttons.length + ' 个词条');
for (const nm of ['雷神', '淬毒', '死亡', '侵袭', '饥荒', '冰冻', '飞升', '掠袭', 'XiYingKill', '狂骨', '斩绝', '爆破', '混沌打击', '完全混沌']) {
    ok(gp._form.buttons.join('').indexOf(nm) >= 0, '武器分类里有「' + nm + '」');
}

// ③ 选第一个词条 → 等级表单
gp._cb(gp, 0);
ok(gp._form.kind === 'custom', '选词条后弹出等级表单');
ok(gp._form.sliders.length === 1, '等级表单有 1 个滑块');
eq(gp._form.sliders[0].max, 10, '雷神滑块范围 1~10');

// ④ 提交 5 级 → 写入 lore
gp._cb(gp, [5]);
ok(gp._item.lore.some((l) => l.indexOf('雷神') >= 0), '表单提交后 lore 写入');

// ④b 一键清除：主菜单第 3 项 → 确认 → 词条被移除
const clearP = makeEnchantPlayer({ uuid: 'gui-clear' });
legui.callback(null, { player: clearP }, makeOut());
// 先手动写两行 lore（一行词条 + 一行普通文案）
clearP._item.lore = ['§b雷神 §fIII', '§7这是普通说明文字'];
clearP._cb(clearP, 2);                       // 点「一键清除」
ok(clearP._form != null && clearP._form.kind === 'simple', '弹出清除确认页');
eq(clearP._form.buttons.length, 2, '确认页有「确认清除/取消」两个按钮');
ok(clearP._form.content.indexOf('雷神') >= 0, '确认页列出了要移除的词条：' + clearP._form.content.replace(/\n/g, ' / '));
clearP._cb(clearP, 0);                       // 点「确认清除」
ok(clearP._item.lore.join('|').indexOf('雷神') < 0, '词条行被移除了');
ok(clearP._item.lore.join('|').indexOf('普通说明文字') >= 0, '普通 lore 行被保留');
ok(clearP.msgs.join('').indexOf('已清除') >= 0, '给了清除成功提示：' + clearP.msgs.join(' | '));

// 取消按钮不动手
const cancelP = makeEnchantPlayer({ uuid: 'gui-cancel' });
legui.callback(null, { player: cancelP }, makeOut());
cancelP._item.lore = ['§b雷神 §fIII'];
cancelP._cb(cancelP, 2);
cancelP._cb(cancelP, 1);                     // 点「取消」
ok(cancelP._item.lore.join('|').indexOf('雷神') >= 0, '点取消不会清除');

// ⑤ 护甲分类：现在有 7 个「领域」词条
const gp2 = makeEnchantPlayer({ uuid: 'gui-2', type: 'minecraft:netherite_chestplate' });
gOut = makeOut();
legui.callback(null, { player: gp2 }, gOut);
ok(gp2._form.buttons[1].indexOf('护甲') >= 0, '主菜单第 2 项是护甲');
gp2._cb(gp2, 1);   // 点「护甲」
eq(gp2._form.buttons.length, 9, '护甲分类有 9 个词条');
for (const nm of ['雷之领域', '死亡领域', '侵袭之域', '荒芜领域', '寒冰领域', '苍空领域', '掠袭领域', '混沌领域', '终焉混沌']) {
    ok(gp2._form.buttons.join('').indexOf(nm) >= 0, '护甲分类里有「' + nm + '」');
}
// 胸甲上选「寒冰领域」→ 应该能进等级表单
const idxChill = gp2._form.buttons.findIndex((b) => b.indexOf('寒冰领域') >= 0);
gp2._cb(gp2, idxChill);
ok(gp2._form.kind === 'custom', '护甲词条也能进等级表单');

// ⑥ 手持不是武器时，武器分类里会标「不适用当前手持」
const gpBow = makeEnchantPlayer({ uuid: 'gui-bow', type: 'minecraft:bow' });
legui.callback(null, { player: gpBow }, makeOut());
gpBow._cb(gpBow, 0);   // 进武器分类
ok(gpBow._form.buttons.join('').indexOf('不适用当前手持') >= 0, '不匹配手持的词条会被标注');
// 点一个不适用的 → 应该被拒绝，不弹等级表单
const beforeKind = gpBow._form.kind;
const idxThunder = gpBow._form.buttons.findIndex((b) => b.indexOf('雷神') >= 0);
gpBow._cb(gpBow, idxThunder);
ok(gpBow.msgs.join('').indexOf('只能用在') >= 0, '点不适用的词条会被拒绝：' + gpBow.msgs.join(' | '));

// 缺 API 时给明确错误，而不是抛 "not a function"
const savedCustom = global.mc.newCustomForm;
delete global.mc.newCustomForm;
const mp = makeEnchantPlayer({ uuid: 'gui-missing' });
gOut = makeOut();
legui.callback(null, { player: mp }, gOut);
ok(gOut.err.join('').indexOf('newCustomForm') >= 0,
    '缺 newCustomForm 时给出明确提示：' + gOut.err.join(''));
global.mc.newCustomForm = savedCustom;

console.log('\n============================');
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
if (failures.length > 0) {
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
}
console.log('冒烟测试通过 ✅');
process.exit(0);
