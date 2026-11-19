"use strict";
/**
 * 通用小工具：随机、消息、坐标、类型判断、临时记录。
 * 这里所有函数都不碰游戏对象，纯计算，方便离线测试。
 */

/** 百分比命中判定：chance 为 0~100 */
function roll(chance, rng) {
    const p = Number(chance);
    if (!isFinite(p) || p <= 0) return false;
    if (p >= 100) return true;
    const r = typeof rng === 'function' ? rng() : Math.random();
    return r * 100 < p;
}

/** 从数组里按等级取值（等级 1 起），超出范围取最后一档 */
function byLevel(arr, level) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const i = Math.min(Math.max(1, Math.floor(Number(level) || 1)), arr.length) - 1;
    return arr[i];
}

/** 物品标准类型名 → 去掉 minecraft: 前缀的小写名 */
function shortType(type) {
    return String(type == null ? '' : type).trim().toLowerCase().replace(/^minecraft:/, '');
}

const SLOT_RULES = {
    any: () => true,
    hand: () => true,
    weapon: (t) => /_sword$/.test(t) || /_axe$/.test(t) || t === 'trident' || t === 'mace',
    sword: (t) => /_sword$/.test(t),
    axe: (t) => /_axe$/.test(t),
    bow: (t) => t === 'bow' || t === 'crossbow',
    pickaxe: (t) => /_pickaxe$/.test(t),
    shovel: (t) => /_shovel$/.test(t),
    // 护甲：除了四件套，还要认鞘翅和头颅（头颅包括玩家头颅/生物头颅）
    armor: (t) => /_helmet$/.test(t) || /_chestplate$/.test(t) || /_leggings$/.test(t) || /_boots$/.test(t)
        || t === 'elytra' || t === 'skull' || t === 'carved_pumpkin',
    helmet: (t) => /_helmet$/.test(t),
    chest: (t) => /_chestplate$/.test(t),
    legs: (t) => /_leggings$/.test(t),
    boots: (t) => /_boots$/.test(t),
};

/** 物品是否符合某个槽位规则 */
function slotMatches(type, slot) {
    const rule = SLOT_RULES[String(slot)];
    if (rule == null) return false;
    return rule(shortType(type));
}

/**
 * 物品签名：类型 + lore 拼起来，用来做解析缓存。
 * 注意 lore 可能是普通数组，也可能是 NbtList 这类「有 length 但不是 Array」的对象，
 * 所以这里不要求 Array.isArray，只要求能按下标读。
 * @param {String} type 物品标准类型名
 * @param {Array|Object} lines lore 行（数组或类数组）
 */
function signature(type, lines) {
    const t = shortType(type);
    const parts = [];
    if (lines != null && typeof lines.length === 'number') {
        for (let i = 0; i < lines.length; i++) {
            parts.push(String(lines[i] == null ? '' : lines[i]));
        }
    }
    return t + '|' + parts.join('\u0001');
}

/** 把任意坐标对象转成 "x y z"（保留一位小数，避免长串） */
function fmtPos(pos) {
    if (pos == null) return null;
    const x = Number(pos.x);
    const y = Number(pos.y);
    const z = Number(pos.z);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    const f = (v) => (Math.round(v * 10) / 10).toFixed(1);
    return f(x) + ' ' + f(y) + ' ' + f(z);
}

/** 精简的等级显示：1→I，5→V，超过 10 用数字 */
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
function roman(level) {
    const n = Math.floor(Number(level) || 0);
    return n >= 1 && n < ROMAN.length ? ROMAN[n] : String(n);
}

exports.roll = roll;
exports.byLevel = byLevel;
exports.shortType = shortType;
exports.slotMatches = slotMatches;
exports.signature = signature;
exports.fmtPos = fmtPos;
exports.roman = roman;
exports.SLOT_RULES = SLOT_RULES;
