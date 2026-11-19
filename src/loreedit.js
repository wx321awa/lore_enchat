"use strict";
/**
 * Lore 编辑：把「词条 + 等级」写成 lore 行，或从 lore 里删掉。
 *
 * 单独成模块的好处：核心逻辑（哪行该删、哪行该加）是纯函数，能离线测试；
 * 只有「写回物品」那一步碰游戏 API。
 */
const { parseLine } = require("plugins/lore_enchant/src/parse");
const { roman } = require("plugins/lore_enchant/src/util");

/**
 * 词条在 lore 里长什么样：`§b雷神 §fIII`（颜色可用 def.color 覆盖，例如 XiYingKill 是红色）
 * 注意：解析器会先剥颜色码，所以实际被读到的是「雷神 III」。
 */
function lineFor(def, level) {
    const color = (def != null && def.color != null) ? String(def.color) : '§b';
    return color + def.name + ' §f' + roman(level);
}

/** 这一行是不是已经写了某个词条（按解析结果判断，容忍各种写法） */
function lineHasEnchant(line, id) {
    const hits = parseLine(line, { requireLevel: true });
    for (let i = 0; i < hits.length; i++) {
        if (hits[i].id === id) return true;
    }
    return false;
}

/**
 * 在 lore 行数组里设置某个词条：已有的同名词条行会被替换，其它行原样保留。
 * @param {Array|Object} lines 现有 lore（数组或类数组）
 * @param {Object} def 词条定义（需要 id / name）
 * @param {number} level 等级
 * @returns {string[]} 新的 lore 行数组
 */
function setEnchantLine(lines, def, level) {
    const out = [];
    if (lines != null && typeof lines.length === 'number') {
        for (let i = 0; i < lines.length; i++) {
            const raw = String(lines[i] == null ? '' : lines[i]);
            if (lineHasEnchant(raw, def.id)) continue; // 旧的那行丢掉，最后统一追加
            out.push(raw);
        }
    }
    out.push(lineFor(def, level));
    return out;
}

/**
 * 从 lore 里删掉某个词条。
 * @returns {string[]} 新的 lore 行数组（可能为空数组 = 清空 lore）
 */
function removeEnchantLine(lines, id) {
    const out = [];
    if (lines != null && typeof lines.length === 'number') {
        for (let i = 0; i < lines.length; i++) {
            const raw = String(lines[i] == null ? '' : lines[i]);
            if (lineHasEnchant(raw, id)) continue;
            out.push(raw);
        }
    }
    return out;
}

/**
 * 把改好的物品写回玩家手里。
 * 不同 LSE 版本/物品上可用的路径不一样，这里按顺序都试一遍，返回试过的路径名。
 * @returns {string[]} 试过的路径（给诊断用）
 */
function writeBackToHand(player, item) {
    const tried = [];
    if (player == null || item == null) return tried;

    try {
        if (typeof player.setHand === 'function') {
            player.setHand(item);
            tried.push('setHand');
        }
    } catch (e) {
        tried.push('setHand(失败:' + e + ')');
    }

    try {
        const inv = (typeof player.getInventory === 'function') ? player.getInventory() : null;
        const slot = (player.selectedSlot != null) ? player.selectedSlot : null;
        if (inv != null && typeof inv.setItem === 'function' && slot != null) {
            inv.setItem(slot, item);
            tried.push('inventory.setItem');
        }
    } catch (e) {
        tried.push('inventory.setItem(失败:' + e + ')');
    }

    return tried;
}

exports.lineFor = lineFor;
exports.lineHasEnchant = lineHasEnchant;
exports.setEnchantLine = setEnchantLine;
exports.removeEnchantLine = removeEnchantLine;
exports.writeBackToHand = writeBackToHand;

// ---------------------------------------------------------------- 落地到物品
const gear = require("plugins/lore_enchant/src/gear");

/** 玩家手持物品所在的槽位号（不同版本字段名不一样，逐个试） */
const HAND_SLOT_KEYS = ['selectedSlot', 'selectedItemSlot', 'hotbarSlot'];

function heldSlot(player) {
    for (let i = 0; i < HAND_SLOT_KEYS.length; i++) {
        const v = player[HAND_SLOT_KEYS[i]];
        if (typeof v === 'number' && isFinite(v) && v >= 0 && v < 64) return v;
    }
    return null;
}

function containerOf(player) {
    try {
        return (typeof player.getInventory === 'function') ? player.getInventory() : null;
    } catch (e) {
        return null;
    }
}

/**
 * 读「玩家真正手持的那件物品」。
 * 优先从物品栏容器里取（那才是服务端真正持有的对象），拿不到再退回 getHand()。
 * @returns {{item:Object, via:string, inv:Object, slot:number}|null}
 */
function readHeld(player) {
    const inv = containerOf(player);
    const slot = heldSlot(player);
    if (inv != null && slot != null && typeof inv.getItem === 'function') {
        try {
            const it = inv.getItem(slot);
            if (it != null) return { item: it, via: 'inventory', inv: inv, slot: slot };
        } catch (e) { }
    }
    const it2 = gear.handItem(player);
    if (it2 == null) return null;
    return { item: it2, via: 'hand', inv: inv, slot: slot };
}

/**
 * 把整份 lore 行写到手持物品上（改 → 写回容器 → refreshItems → 读回校验）。
 * applyToHeld / clearAllEnchants 都走这里。
 * @returns {{ok:boolean, msg:string, lines:number, paths:string[], via:string, parsed:string}}
 */
function writeLinesToHeld(player, after) {
    const loc = readHeld(player);
    if (loc == null) return { ok: false, msg: '请先手持要改的物品', lines: 0, paths: [], via: '?', parsed: '' };

    let setOk = false;
    try {
        setOk = loc.item.setLore(after) !== false;
    } catch (e) {
        return { ok: false, msg: '写 lore 抛错: ' + e, lines: 0, paths: [], via: loc.via, parsed: '' };
    }
    if (!setOk) {
        return { ok: false, msg: 'item.setLore 返回失败（这个物品可能不支持改 lore）', lines: 0, paths: [], via: loc.via, parsed: '' };
    }

    const paths = [];
    if (loc.inv != null && loc.slot != null && typeof loc.inv.setItem === 'function') {
        try {
            loc.inv.setItem(loc.slot, loc.item);
            paths.push('inventory.setItem');
        } catch (e) {
            paths.push('inventory.setItem(失败)');
        }
    }
    try {
        if (typeof player.setHand === 'function') {
            player.setHand(loc.item);
            paths.push('setHand');
        }
    } catch (e) { }
    try {
        if (typeof player.refreshItems === 'function') {
            player.refreshItems();
            paths.push('refreshItems');
        }
    } catch (e) { }

    gear.clearCache();

    const again = readHeld(player);
    const linesNow = gear.readLore(again != null ? again.item : loc.item);

    return {
        ok: true,
        msg: 'ok',
        lines: after.length,
        paths: paths,
        via: loc.via,
        parsed: linesNow.join(' / '),
        actual: linesNow,
    };
}

/**
 * 给玩家手持物品写上某个词条的 lore。
 * @returns {{ok:boolean, msg:string, lines?:number, paths?:string[], parsed?:string}}
 */
function applyToHeld(player, def, level) {
    if (player == null) return { ok: false, msg: '需要在游戏里执行' };
    const loc = readHeld(player);
    if (loc == null) return { ok: false, msg: '请先手持要附魔的物品' };

    const before = gear.readLore(loc.item);
    const after = setEnchantLine(before, def, level);
    const r = writeLinesToHeld(player, after);

    const okNow = (r.actual || []).join('\n').indexOf(def.name) >= 0;
    if (!r.ok) return r;
    return {
        ok: okNow,
        msg: okNow ? 'ok' : '写回后读不到新 lore',
        lines: r.lines,
        paths: r.paths,
        via: r.via,
        parsed: r.parsed,
    };
}

/**
 * 一键清除：把物品上**所有本插件的词条行**删掉（其它 lore 原样保留）。
 * @returns {{ok:boolean, msg:string, removed:number, kept:number, paths?:string[]}}
 */
function clearAllEnchants(player) {
    if (player == null) return { ok: false, msg: '需要在游戏里执行', removed: 0, kept: 0 };
    const loc = readHeld(player);
    if (loc == null) return { ok: false, msg: '请先手持要清除的物品', removed: 0, kept: 0 };

    const lines = gear.readLore(loc.item);
    const kept = [];
    let removed = 0;
    for (let i = 0; i < lines.length; i++) {
        const raw = String(lines[i] == null ? '' : lines[i]);
        const hits = parseLine(raw, { requireLevel: true });
        if (hits.length > 0) {
            removed++;              // 这行含本插件词条 → 删掉
            continue;
        }
        kept.push(raw);
    }

    if (removed === 0) {
        return { ok: false, msg: '这件物品上没有本插件的词条', removed: 0, kept: kept.length };
    }

    const r = writeLinesToHeld(player, kept);
    return {
        ok: r.ok,
        msg: r.ok ? 'ok' : r.msg,
        removed: removed,
        kept: kept.length,
        paths: r.paths || [],
    };
}

exports.applyToHeld = applyToHeld;
exports.clearAllEnchants = clearAllEnchants;
exports.writeLinesToHeld = writeLinesToHeld;
exports.readHeld = readHeld;
exports.heldSlot = heldSlot;
exports.containerOf = containerOf;
