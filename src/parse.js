"use strict";
/**
 * Lore 解析：把物品 lore 的每一行，解析成「词条 → 等级」。
 *
 * 认的写法（一行可以写多个）：
 *   雷神            ← 只有 require_level=false 时才认（默认不认）
 *   雷神I   雷神 II   雷神3   雷神3级   雷神 等级3   雷神 Lv.3
 *   雷神+2  雷神 提升2
 *   雷神III 吸血II          ← 一行两个
 *   thunder2  lifesteal:2   ← 英文 id 也认
 *   §c雷神§r II             ← 颜色码会自动剥掉
 *
 * 故意不认的：
 *   - 关键词后面紧跟 %（`攻击速度+10%` 是在写属性，不是词条）
 *   - 整行命中黑名单词（默认 上限/概率/几率，避免和别的插件抢）
 *   - 关键词后面没有等级（默认必须带等级，防止 lore 里随便出现个名字就触发）
 */
const { Enchants } = require("plugins/lore_enchant/src/enchants");

const ROMAN_VALUE = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
const ASCII_KW = /^[\x20-\x7e]+$/;

/** 去掉 § 颜色码 */
function stripColor(text) {
    const s = String(text == null ? '' : text);
    return s.indexOf('§') >= 0 ? s.replace(/§./g, '') : s;
}

/** 全角 → 半角 */
function toHalf(s) {
    if (!/[\uFF01-\uFF5E\u3000]/.test(s)) return s;
    return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ');
}

/** 罗马数字 → 整数 */
function romanToInt(token) {
    const up = String(token).toLowerCase();
    if (!/^[ivxlcdm]+$/.test(up)) return 0;
    let total = 0;
    let prev = 0;
    for (let i = up.length - 1; i >= 0; i--) {
        const v = ROMAN_VALUE[up[i]] || 0;
        if (v < prev) total -= v;
        else {
            total += v;
            prev = v;
        }
    }
    return total;
}

const LEVEL_RE = new RegExp(
    '^[\\s:：=＝\\-+＋]*' +
    '(?:等级为|等级|级别|Lv\\.?|LV\\.?|lv\\.?|level)?' +
    '[\\s:：=＝\\-+＋]*' +
    '(?:增加|提升|加成|加|给)?' +
    '[\\s:：=＝\\-+＋]*' +
    '([IVXLCDivxlcd]+|\\d+)'
);

/**
 * 从 pos 开始读等级。
 * @returns {{level:number,next:number,hasToken:boolean}|{skip:true,next:number}}
 */
function levelAt(s, pos, maxLevel) {
    const m = LEVEL_RE.exec(s.substring(pos));
    if (m == null) return { level: 1, next: pos, hasToken: false };
    const token = m[1];
    const end = pos + m[0].length;
    if (s.charAt(end) === '%') return { skip: true, next: end + 1 };
    let lv = /^\d+$/.test(token) ? parseInt(token, 10) : romanToInt(token);
    if (!isFinite(lv) || lv <= 0) lv = 1;
    const cap = (isFinite(Number(maxLevel)) && Number(maxLevel) > 0) ? Math.floor(Number(maxLevel)) : 5;
    if (lv > cap) lv = cap;
    return { level: lv, next: end, hasToken: true };
}

/**
 * 解析一行。
 * @param {String} text
 * @param {{maxLevel?:number, requireLevel?:boolean, blacklist?:string[]}} opts
 * @returns {Array<{id:string,name:string,level:number}>}
 */
function parseLine(text, opts) {
    const out = [];
    const o = opts || {};
    const requireLevel = o.requireLevel !== false;
    const blacklist = Array.isArray(o.blacklist) ? o.blacklist : [];
    const s = toHalf(stripColor(text));
    if (s.length === 0) return out;

    for (let b = 0; b < blacklist.length; b++) {
        const w = String(blacklist[b]);
        if (w.length > 0 && s.indexOf(w) >= 0) return out;
    }

    // require_marker：整行必须含这个符号才解析（例如只认「⬥ 雷神II」）
    const marker = (o.marker == null) ? '' : String(o.marker);
    if (marker.length > 0 && s.indexOf(marker) < 0) return out;

    const keys = Enchants.KEYS;
    let i = 0;
    while (i < s.length) {
        let found = null;
        for (let k = 0; k < keys.length; k++) {
            const kw = keys[k];
            if (kw.length === 0 || i + kw.length > s.length) continue;
            if (s.substr(i, kw.length).toLowerCase() !== kw) continue;
            if (ASCII_KW.test(kw)) {
                const prev = i > 0 ? s.charAt(i - 1) : '';
                const next = i + kw.length < s.length ? s.charAt(i + kw.length) : '';
                if (/[a-z]/i.test(prev) || /[a-z]/i.test(next)) continue;
            }
            found = kw;
            break;
        }
        if (found == null) {
            i++;
            continue;
        }
        const def = Enchants.byKey(found);
        const afterKw = i + found.length;
        if (def == null) {
            i = afterKw;
            continue;
        }
        const cap = def.maxLevel != null ? def.maxLevel : (o.maxLevel != null ? o.maxLevel : 5);
        const lv = levelAt(s, afterKw, cap);
        if (lv.skip === true) {
            i = Math.max(lv.next, afterKw);
            continue;
        }
        if (requireLevel && lv.hasToken !== true) {
            i = Math.max(lv.next, afterKw);
            continue;
        }
        out.push({ id: def.id, name: def.name, level: lv.level });
        i = Math.max(lv.next, afterKw);
    }
    return out;
}

/**
 * 解析整件物品：一行里重复写的词条取最高等级。
 * @returns {Map<string, number>}
 */
function parseItem(item, opts) {
    if (item == null) return new Map();
    let lines = [];
    try {
        const l = item.lore;
        if (l != null && typeof l.length === 'number') lines = l;
    } catch (e) { }
    return parseLines(lines, opts);
}

/**
 * 解析多行 lore（数组或类数组）。
 * 一行里重复写的词条取最高等级。
 * @param {Array|Object} lines
 * @param {{requireLevel?:boolean, blacklist?:string[], marker?:string}} opts
 * @returns {Map<string, number>}
 */
function parseLines(lines, opts) {
    const map = new Map();
    if (lines == null || typeof lines.length !== 'number') return map;
    for (let i = 0; i < lines.length; i++) {
        const hits = parseLine(lines[i], opts);
        for (let h = 0; h < hits.length; h++) {
            const cur = map.get(hits[h].id) || 0;
            if (hits[h].level > cur) map.set(hits[h].id, hits[h].level);
        }
    }
    return map;
}

exports.parseLine = parseLine;
exports.parseItem = parseItem;
exports.parseLines = parseLines;
exports.romanToInt = romanToInt;
exports.stripColor = stripColor;
exports.toHalf = toHalf;
