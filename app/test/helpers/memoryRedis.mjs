// Testler için bellek içi Redis. EVAL komutları GERÇEK Lua betiğiyle,
// fengari (saf JS Lua VM) üzerinde çalıştırılır; betik içindeki redis.call
// çağrıları aynı bellek içi komut yürütücüsüne bağlanır. JS tek iş parçacıklı
// olduğu için bir EVAL, Redis'te olduğu gibi araya başka komut girmeden biter.
// Hiçbir gerçek sisteme bağlanmaz.
import fengari from "fengari";

const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

export function createMemoryRedis(db = new Map()) {
  // db: anahtar -> string | { type: "list", items: [] } | { type: "hash", map: Map }
  //               | { type: "zset", map: Map<üye, skor> }
  const isStr = (v) => typeof v === "string";
  const getList = (key, create) => {
    const v = db.get(key);
    if (v && v.type === "list") return v.items;
    // Gerçek Redis gibi: yanlış türdeki anahtar asla ezilmez.
    if (v !== undefined) throw new Error("WRONGTYPE");
    if (!create) return null;
    const items = [];
    db.set(key, { type: "list", items });
    return items;
  };
  const getHash = (key, create) => {
    const v = db.get(key);
    if (v && v.type === "hash") return v.map;
    // Gerçek Redis gibi: yanlış türdeki anahtar asla ezilmez.
    if (v !== undefined) throw new Error("WRONGTYPE");
    if (!create) return null;
    const map = new Map();
    db.set(key, { type: "hash", map });
    return map;
  };

  const getZset = (key, create) => {
    const v = db.get(key);
    if (v && v.type === "zset") return v.map;
    // Gerçek Redis gibi: yanlış türdeki anahtar asla ezilmez.
    if (v !== undefined) throw new Error("WRONGTYPE");
    if (!create) return null;
    const map = new Map();
    db.set(key, { type: "zset", map });
    return map;
  };
  const scoreBound = (raw) => {
    const s = String(raw);
    if (s === "+inf") return { value: Infinity, open: false };
    if (s === "-inf") return { value: -Infinity, open: false };
    if (s.startsWith("(")) return { value: Number(s.slice(1)), open: true };
    return { value: Number(s), open: false };
  };

  function run(command) {
    const [rawOp, ...args] = command;
    const op = String(rawOp).toUpperCase();
    switch (op) {
      case "GET": {
        const v = db.get(args[0]);
        if (v === undefined) return null;
        if (!isStr(v)) throw new Error("WRONGTYPE");
        return v;
      }
      case "MGET":
        return args.map((k) => (isStr(db.get(k)) ? db.get(k) : null));
      case "SET": {
        const [key, value, ...opts] = args;
        const upper = opts.map((o) => String(o).toUpperCase());
        if (upper.includes("NX") && db.has(key)) return null;
        db.set(key, String(value));
        return "OK";
      }
      case "DEL":
        return args.reduce((n, key) => n + (db.delete(key) ? 1 : 0), 0);
      case "INCR":
      case "DECR": {
        const v = db.get(args[0]);
        if (v !== undefined && !isStr(v)) throw new Error("WRONGTYPE");
        const cur = v === undefined ? 0 : Number(v);
        if (!Number.isInteger(cur)) throw new Error("ERR value is not an integer");
        const next = cur + (op === "INCR" ? 1 : -1);
        db.set(args[0], String(next));
        return next;
      }
      case "EXPIRE":
      case "PEXPIRE":
        return db.has(args[0]) ? 1 : 0;
      // Sıralı küme (AI eşzamanlılık kirası).
      case "ZADD": {
        const map = getZset(args[0], true);
        let added = 0;
        for (let i = 1; i + 1 < args.length; i += 2) {
          const score = Number(args[i]);
          if (!Number.isFinite(score)) throw new Error("ERR value is not a valid float");
          if (!map.has(String(args[i + 1]))) added++;
          map.set(String(args[i + 1]), score);
        }
        return added;
      }
      case "ZREM": {
        const map = getZset(args[0], false);
        if (!map) return 0;
        const n = args.slice(1).reduce((c, m) => c + (map.delete(String(m)) ? 1 : 0), 0);
        if (map.size === 0) db.delete(args[0]);
        return n;
      }
      case "ZCARD":
        return (getZset(args[0], false) || new Map()).size;
      case "ZREMRANGEBYSCORE": {
        const map = getZset(args[0], false);
        if (!map) return 0;
        const min = scoreBound(args[1]);
        const max = scoreBound(args[2]);
        let n = 0;
        for (const [member, score] of [...map]) {
          const aboveMin = min.open ? score > min.value : score >= min.value;
          const belowMax = max.open ? score < max.value : score <= max.value;
          if (aboveMin && belowMax && map.delete(member)) n++;
        }
        if (map.size === 0) db.delete(args[0]);
        return n;
      }
      case "LPUSH": {
        const items = getList(args[0], true);
        for (const v of args.slice(1)) items.unshift(String(v));
        return items.length;
      }
      case "LTRIM": {
        const items = getList(args[0], false);
        if (!items) return "OK";
        const start = Number(args[1]);
        const stop = Number(args[2]);
        const end = stop < 0 ? items.length + stop : stop;
        items.splice(0, items.length, ...items.slice(start, end + 1));
        return "OK";
      }
      case "LRANGE": {
        const items = getList(args[0], false) || [];
        const start = Number(args[1]);
        const stop = Number(args[2]);
        const end = stop < 0 ? items.length + stop : stop;
        return items.slice(start, end + 1);
      }
      case "HSETNX": {
        const map = getHash(args[0], true);
        if (map.has(args[1])) return 0;
        map.set(args[1], String(args[2]));
        return 1;
      }
      case "HSET": {
        const map = getHash(args[0], true);
        let added = 0;
        for (let i = 1; i + 1 < args.length; i += 2) {
          if (!map.has(args[i])) added++;
          map.set(args[i], String(args[i + 1]));
        }
        return added;
      }
      case "HLEN":
        return (getHash(args[0], false) || new Map()).size;
      case "HKEYS":
        return [...(getHash(args[0], false) || new Map()).keys()];
      case "HDEL": {
        const map = getHash(args[0], false);
        if (!map) return 0;
        return args.slice(1).reduce((n, f) => n + (map.delete(f) ? 1 : 0), 0);
      }
      case "HGETALL": {
        const map = getHash(args[0], false) || new Map();
        return [...map.entries()].flat();
      }
      case "HMGET": {
        const map = getHash(args[0], false) || new Map();
        return args.slice(1).map((f) => (map.has(f) ? map.get(f) : null));
      }
      case "SCAN": {
        // Tek seferde tüm eşleşenler (imleç her zaman "0" döner).
        const idx = args.findIndex((a) => String(a).toUpperCase() === "MATCH");
        const pattern = idx >= 0 ? String(args[idx + 1]) : "*";
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
        const re = new RegExp(`^${escaped}$`);
        return ["0", [...db.keys()].filter((k) => re.test(k))];
      }
      case "EVAL":
        return evalLua(args[0], Number(args[1]), args.slice(2));
      default:
        throw new Error(`Test Redis'i bu komutu desteklemiyor: ${op}`);
    }
  }

  // ---- Lua köprüsü (Redis'in tür dönüşüm kurallarına göre) ----
  function pushJs(L, value) {
    if (value === null || value === undefined) lua.lua_pushboolean(L, false);
    else if (typeof value === "number") lua.lua_pushinteger(L, value);
    else if (typeof value === "string") lua.lua_pushstring(L, to_luastring(value));
    else if (Array.isArray(value)) {
      lua.lua_createtable(L, value.length, 0);
      value.forEach((item, i) => {
        pushJs(L, item);
        lua.lua_rawseti(L, -2, i + 1);
      });
    } else throw new Error("Desteklenmeyen dönüş tipi");
  }

  function readLua(L, idx) {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TNIL) return null;
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx) ? 1 : null;
    if (t === lua.LUA_TNUMBER) return Math.trunc(lua.lua_tonumber(L, idx));
    if (t === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, idx));
    if (t === lua.LUA_TTABLE) {
      const abs = lua.lua_absindex(L, idx);
      lua.lua_getfield(L, abs, to_luastring("err"));
      if (lua.lua_type(L, -1) === lua.LUA_TSTRING) {
        const msg = to_jsstring(lua.lua_tostring(L, -1));
        lua.lua_pop(L, 1);
        throw new Error(msg);
      }
      lua.lua_pop(L, 1);
      const out = [];
      for (let i = 1; ; i++) {
        lua.lua_rawgeti(L, abs, i);
        if (lua.lua_type(L, -1) === lua.LUA_TNIL) {
          lua.lua_pop(L, 1);
          break;
        }
        out.push(readLua(L, -1));
        lua.lua_pop(L, 1);
      }
      return out;
    }
    throw new Error("Desteklenmeyen Lua değeri");
  }

  function evalLua(script, numKeys, rest) {
    const keys = rest.slice(0, numKeys).map(String);
    const argv = rest.slice(numKeys).map(String);
    const L = lauxlib.luaL_newstate();
    lualib.luaL_openlibs(L);

    lua.lua_createtable(L, 0, 2);
    lua.lua_pushcfunction(L, (Ls) => {
      const n = lua.lua_gettop(Ls);
      const cmd = [];
      for (let i = 1; i <= n; i++) cmd.push(to_jsstring(lua.lua_tolstring(Ls, i)));
      let result;
      try {
        result = run(cmd);
      } catch (e) {
        lauxlib.luaL_error(Ls, to_luastring(e.message));
        return 0;
      }
      pushJs(Ls, result);
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("call"));
    lua.lua_pushcfunction(L, (Ls) => {
      const msg = lua.lua_tostring(Ls, 1);
      lua.lua_createtable(Ls, 0, 1);
      lua.lua_pushstring(Ls, msg);
      lua.lua_setfield(Ls, -2, to_luastring("err"));
      return 1;
    });
    lua.lua_setfield(L, -2, to_luastring("error_reply"));
    lua.lua_setglobal(L, to_luastring("redis"));

    for (const [name, values] of [["KEYS", keys], ["ARGV", argv]]) {
      pushJs(L, values);
      lua.lua_setglobal(L, to_luastring(name));
    }

    if (lauxlib.luaL_loadstring(L, to_luastring(script)) !== lua.LUA_OK) {
      throw new Error(`Lua derleme hatası: ${to_jsstring(lua.lua_tostring(L, -1))}`);
    }
    if (lua.lua_pcall(L, 0, 1, 0) !== lua.LUA_OK) {
      throw new Error(`Lua çalışma hatası: ${to_jsstring(lua.lua_tostring(L, -1))}`);
    }
    return readLua(L, -1);
  }

  // Upstash /pipeline biçimi: her komut kendi sonucunu ya da hatasını taşır,
  // bir komutun hatası diğerlerini durdurmaz (Upstash'te pipeline atomik değil).
  function pipeline(commands) {
    return commands.map((command) => {
      try {
        return { result: run(command) };
      } catch (e) {
        return { error: e.message };
      }
    });
  }

  return { db, run, pipeline };
}
