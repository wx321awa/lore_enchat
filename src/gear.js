"use strict";
/**
 * 装备读取 + 解析缓存。
 *
 * 两个线上踩过的坑，这里都留了双保险：
 *
 * 1) **读 lore 有两条路**：先用 `item.lore`（属性），读不到再走 NBT
 *    `tag.display.Lore`。不同 LSE 版本 / 不同物品上，其中一条会是空的；
 *    而且 `item.lore` 有可能是 NbtList 这种「有 length 但不是 Array」的对象，
 *    所以判空只能用 `typeof l.length === 'number'`，不能用 Array.isArray。
 *    （只认一条路的版本，在部分服务器上会「一条 lore 都解析不到」= 完全没效果。）
 *
 * 2) **不要用 isNull() 过滤**：基岩版副手槽会出现「isNull 为真但 NBT 能读到 lore」
 *    的对象，信 isNull 会把副手装备整个漏掉。
 */
const { parseLines } = require("plugins/lore_enchant/src/parse");
const { signature, shortType } = require("plugins/lore_enchant/src/util");

const CACHE_LIMIT = 256;
const cache = new Map(); // signature -> Map<id, level>

function parseOpts(cfg) {
    return {
        requireLevel: cfg.require_level !== false,
        blacklist: Array.isArray(cfg.blacklist_line_words) ? cfg.blacklist_line_words : [],
        marker: cfg.require_marker == null ? '' : String(cfg.require_marker),
    };
}

/**
 * 读一件物品的 lore 行（数组；读不到返回空数组）。
 * 先属性，后 NBT —— 两条都要留。
 */
function readLore(item) {
    const out = [];
    if (item == null) return out;

    // 路 1：item.lore（可能是普通数组，也可能是 NbtList 这类类数组）
    try {
        const l = item.lore;
        if (l != null && typeof l.length === 'number') {
            for (let i = 0; i < l.length; i++) {
                const one = l[i];
                if (one == null) continue;
                out.push(String(one));
            }
        }
    } catch (e) { }
    if (out.length > 0) return out;

    // 路 2：NBT 的 tag.display.Lore
    try {
        const nbt = (typeof item.getNbt === 'function') ? item.getNbt() : null;
        const tag = nbt == null ? null : nbt.getTag('tag');
        const display = tag == null ? null : tag.getTag('display');
        const lore = display == null ? null : display.getTag('Lore');
        if (lore == null) return out;

        let size = 0;
        try { size = Number(lore.getSize()); } catch (e) { size = 0; }
        if (!isFinite(size) || size <= 0) return out;

        for (let i = 0; i < size; i++) {
            let raw = null;
            try { raw = lore.getData(i); } catch (e) { raw = null; }
            if (raw == null) continue;
            if (typeof raw === 'string') out.push(raw);
            else if (typeof raw.get === 'function') {
                try { out.push(String(raw.get())); } catch (e) { out.push(String(raw)); }
            } else {
                out.push(String(raw));
            }
        }
    } catch (e) { }
    return out;
}

/** 解析一件物品的 lore，带缓存 */
function enchantsOf(item, cfg) {
    if (item == null) return new Map();
    const lines = readLore(item);
    const sig = signature(item.type, lines);
    const hit = cache.get(sig);
    if (hit != null) return hit;

    let map;
    try {
        map = parseLines(lines, parseOpts(cfg));
    } catch (e) {
        map = new Map();
        log('[lore_enchant] 解析出错: ' + e);
    }
    if (cache.size >= CACHE_LIMIT) {
        let n = 0;
        for (const k of cache.keys()) {
            cache.delete(k);
            if (++n >= CACHE_LIMIT / 2) break;
        }
    }
    cache.set(sig, map);

    // debug 打开时，把「读了几行 / 解析出几个词条」打出来 —— 排「没效果」最快的入口
    if (cfg != null && cfg.debug === true) {
        log('[lore_enchant] 解析 ' + shortType(item.type) + '：读了 ' + lines.length
            + ' 行 lore → ' + map.size + ' 个词条'
            + (lines.length > 0 ? '（首行: ' + String(lines[0]).slice(0, 40) + '）' : ''));
    }
    return map;
}

/** 主手物品（读不到返回 null） */
function handItem(player) {
    try {
        return player.getHand() || null;
    } catch (e) {
        return null;
    }
}

/** 副手物品 */
function offItem(player) {
    try {
        return player.getOffHand() || null;
    } catch (e) {
        return null;
    }
}

/** 盔甲栏 4 件（按 getArmor().getAllItems() 顺序，读不到返回 []） */
function armorItems(player) {
    try {
        const armor = player.getArmor();
        if (armor != null && typeof armor.getAllItems === 'function') {
            return armor.getAllItems() || [];
        }
        if (Array.isArray(armor)) return armor;
    } catch (e) { }
    return [];
}

/**
 * 收集玩家当前装备上所有词条。
 * @returns {Array<{where:string,item:Object,enchants:Map<string,number>}>}
 */
function collect(player, cfg) {
    const out = [];
    const push = (where, item) => {
        if (item == null) return;
        out.push({ where: where, item: item, enchants: enchantsOf(item, cfg) });
    };
    push('主手', handItem(player));
    push('副手', offItem(player));
    const armor = armorItems(player);
    const names = ['头盔', '胸甲', '护腿', '靴子'];
    for (let i = 0; i < armor.length; i++) {
        push(names[i] || ('盔甲' + (i + 1)), armor[i]);
    }
    return out;
}

/** 清缓存（reload 配置后调用，避免旧解析结果残留） */
function clearCache() {
    cache.clear();
}

exports.readLore = readLore;
exports.enchantsOf = enchantsOf;
exports.handItem = handItem;
exports.offItem = offItem;
exports.armorItems = armorItems;
exports.collect = collect;
exports.clearCache = clearCache;
