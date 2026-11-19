"use strict";
/**
 * 配置读写：config/lore_enchant/config.json
 *
 * 原则和 lore_effect 一致：
 *   1. 缺键用默认值兜底，并把补全后的完整配置写回文件 —— 否则服主在 config 里
 *      看不到新加的开关。
 *   2. 文件坏了不崩插件：备份成 .broken，按默认值继续跑。
 *   3. 每个词条的概率/数值都摊在 config 里，改数值不用改代码。
 */
const { Enchants } = require("plugins/lore_enchant/src/enchants");

const DIR = 'config/lore_enchant/';
const PATH = DIR + 'config.json';

/** 按注册表生成「每个词条的默认配置」 */
function defaultEnchants() {
    const out = {};
    for (const e of Enchants.LIST) {
        const one = { enabled: true };
        if (Array.isArray(e.chance) && e.chance.length > 0) one.chance = e.chance.slice();
        if (e.params && Object.keys(e.params).length > 0) one.params = Object.assign({}, e.params);
        if (e.params && e.params.cooldownMs != null) one.cooldown_ms = e.params.cooldownMs;
        else one.cooldown_ms = e.trigger === 'tick' ? 0 : 200;
        out[e.id] = one;
    }
    return out;
}

/**
 * 配置格式版本。改动默认值的行为时要 +1，并在 load() 里写迁移：
 * v1 → v2：announce_triggers 默认改成 true
 * v2 → v3：词条概率数组变了（雷神 5 档 → 7 档）
 * v3 → v4：announce_triggers 默认改回 **false**（触发提示默认关闭）
 * v4 → v5：雷神概率又变了（7 档 → 10 档，每级 +10%）
 *
 * 通用规则：只要版本号涨了，就按「配置里 chance 数组长度 ≠ 代码里长度」刷新一次，
 * 这样老配置不会被旧默认值一直盖着（实测踩过：改了代码但 /le list 还是旧数字）。
 */
const CONFIG_VERSION = 5;

const DEFAULTS = {
    /** 配置格式版本（插件自己维护，别手改） */
    config_version: CONFIG_VERSION,
    /** 总开关 */
    enabled: true,
    /** 关键词后面必须跟等级（默认 true）。false = 只写「雷神」也算 I 级 */
    require_level: true,
    /** 命中这些词的整行不解析（防止和写属性/概率的 lore 打架） */
    blacklist_line_words: ['上限', '概率', '几率'],
    /**
     * 只解析含这个符号的行，例如填 '⬥' 就只认「⬥ 雷神II」。
     * 留空 = 任意行都解析。
     */
    require_marker: '',
    /** 是否显示药水粒子 */
    show_particles: false,
    /**
     * 触发时是否给**玩家**发聊天提示（例如「§e雷神之力！！！」）。
     * 默认 **false**（v0.4.0 起默认关闭；想看提示就在 config 里改成 true）。
     * 注意：失败提示（找不到坐标 / 召唤失败）不受这个开关影响，始终会提示。
     */
    announce_triggers: false,
    /** 播放触发音效（会额外跑一条 playsound 命令，吵的话关掉） */
    play_sounds: true,
    /** 每次触发写一条控制台日志（调试用，线上建议 false） */
    log_triggers: false,
    /** 打印解析明细 */
    debug: false,
    /** 盔甲被动（夜视/生命提升）的续期间隔，毫秒 */
    passive_interval_ms: 1000,
    /** 每个词条的细化配置，键 = 词条 id */
    enchants: defaultEnchants(),
};

const Config = {
    current: null,
    DIR: DIR,
    PATH: PATH,
    defaults: DEFAULTS,
};

Config.ensureDir = function () {
    if (typeof File === 'undefined' || File == null) return;
    const parts = DIR.split('/').filter((s) => s.length > 0);
    let cur = '';
    for (const part of parts) {
        cur += part + '/';
        try {
            if (!File.exists(cur)) File.createDir(cur);
        } catch (e) { }
    }
};

/** 把用户配置里缺的词条补进 enchants（新版本加了词条，老配置也能用） */
function mergeEnchants(got) {
    const base = defaultEnchants();
    const out = {};
    const gotMap = (got != null && typeof got === 'object') ? got : {};
    for (const id of Object.keys(base)) {
        const d = base[id];
        const u = gotMap[id];
        if (u != null && typeof u === 'object') {
            out[id] = {
                enabled: u.enabled !== false,
                chance: Array.isArray(u.chance) && u.chance.length > 0 ? u.chance : d.chance,
                params: Object.assign({}, d.params || {}, (u.params != null && typeof u.params === 'object') ? u.params : {}),
                cooldown_ms: isFinite(Number(u.cooldown_ms)) ? Number(u.cooldown_ms) : d.cooldown_ms,
            };
        } else {
            out[id] = d;
        }
    }
    return out;
}

Config.load = function () {
    let obj = null;
    let hadFile = false;
    let broken = false;

    try {
        if (typeof File !== 'undefined' && File != null && File.exists(PATH)) {
            hadFile = true;
            const raw = File.readFrom(PATH);
            if (raw != null && String(raw).length > 0) obj = JSON.parse(String(raw));
        }
    } catch (e) {
        broken = true;
        obj = null;
        try {
            File.writeTo(PATH + '.broken', File.readFrom(PATH));
            File.delete(PATH);
        } catch (e2) { }
        log('[lore_enchant] 配置解析失败，已备份成 config.json.broken，本次按默认值运行: ' + e);
    }

    const conf = {};
    for (const k of Object.keys(DEFAULTS)) {
        if (k === 'enchants') continue;
        conf[k] = DEFAULTS[k];
    }
    if (obj != null && typeof obj === 'object') {
        for (const k of Object.keys(DEFAULTS)) {
            if (k === 'enchants') continue;
            if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) conf[k] = obj[k];
        }
    }
    conf.enchants = mergeEnchants(obj != null ? obj.enchants : null);

    // ---- 老配置迁移 ----
    const oldVer = Number((obj != null && obj.config_version != null) ? obj.config_version : 1);
    const notes = [];

    if (!(oldVer >= CONFIG_VERSION)) {
        // 刷新「过期的默认概率」：配置里的 chance 数组长度和代码里的不一致
        // → 说明是旧版本的默认值，换成新的（连冷却一起，避免 100% 还被旧冷却吃掉）
        const fresh = defaultEnchants();
        const refreshed = [];
        for (const id of Object.keys(fresh)) {
            const one = conf.enchants[id];
            const def = fresh[id];
            if (one == null || !Array.isArray(def.chance)) continue;
            const oldArr = Array.isArray(one.chance) ? one.chance : [];
            if (oldArr.length !== def.chance.length) {
                one.chance = def.chance.slice();
                one.cooldown_ms = def.cooldown_ms;
                refreshed.push(id);
            }
        }
        if (refreshed.length > 0) notes.push('刷新概率数组: ' + refreshed.join(', '));

        if (!(oldVer >= 4)) {
            // v3 → v4：触发提示默认关闭
            conf.announce_triggers = false;
            notes.push('触发提示改为默认关闭');
        }

        conf.config_version = CONFIG_VERSION;
        log('[lore_enchant] 配置已从 v' + oldVer + ' 迁移到 v' + CONFIG_VERSION
            + (notes.length > 0 ? '（' + notes.join('；') + '）' : ''));
    }
    Config.current = conf;

    // 首次生成 / 坏文件 / 缺词条 → 写回完整配置
    const missing = [];
    if (obj == null) {
        missing.push('(整份)');
    } else {
        for (const k of Object.keys(DEFAULTS)) {
            if (!Object.prototype.hasOwnProperty.call(obj, k)) missing.push(k);
        }
        const gotE = (obj.enchants != null && typeof obj.enchants === 'object') ? obj.enchants : {};
        for (const e of Enchants.LIST) {
            if (!Object.prototype.hasOwnProperty.call(gotE, e.id)) missing.push('enchants.' + e.id);
        }
    }
    if (missing.length > 0) {
        Config.ensureDir();
        try {
            File.writeTo(PATH, JSON.stringify(conf, null, 2));
            if (hadFile && !broken) log('[lore_enchant] 配置已补齐: ' + missing.join(', '));
        } catch (e) {
            log('[lore_enchant] 配置写入失败: ' + e);
        }
    }
    return conf;
};

Config.get = function () {
    if (Config.current == null) Config.load();
    return Config.current;
};

/**
 * 取某个词条合并后的配置（注册表默认值 ← config 覆盖）。
 * @returns {{enabled:boolean,chance:number[],params:Object,cooldown_ms:number,def:Object}}
 */
Config.forEnchant = function (id) {
    const cfg = Config.get();
    const def = Enchants.byId(id);
    const one = (cfg.enchants && cfg.enchants[id]) || {};
    return {
        enabled: one.enabled !== false,
        chance: Array.isArray(one.chance) ? one.chance : ((def && def.chance) || []),
        params: Object.assign({}, (def && def.params) || {}, one.params || {}),
        cooldown_ms: isFinite(Number(one.cooldown_ms)) ? Number(one.cooldown_ms) : 200,
        def: def,
    };
};

exports.Config = Config;
exports.defaultEnchants = defaultEnchants;
