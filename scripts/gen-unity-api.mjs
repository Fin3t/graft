#!/usr/bin/env node
/**
 * Generate `src/graph/data/unity-api.json` — the external C# API surface the C#
 * resolver types member chains with — from an installed Unity editor.
 *
 *   node scripts/gen-unity-api.mjs [<Unity.app/Contents>] [--out src/graph/data/unity-api.json]
 *
 * Sources (all of the editor version being targeted):
 *   - the reference assemblies `Resources/Scripting/Managed/UnityEngine/*.dll`
 *     (UnityEngine.* and UnityEditor.* modules) and the .NET Standard 2.1
 *     reference `Resources/Scripting/NetStandard/ref/2.1.0/netstandard.dll`,
 *     read directly as ECMA-335 metadata (no .NET runtime needed): public types,
 *     their base type, interfaces, generic parameters, and their public members'
 *     types; attribute types are the types deriving from System.Attribute.
 *   - Unity's messages (Update, OnTriggerEnter, …) are not declared in any
 *     assembly or XML doc — the engine calls them by name — so they come from the
 *     ScriptReference of the same version (URLs below), checked by hand.
 *
 * The output is deterministic (sorted) and committed, so graft resolves
 * identically on a machine without Unity.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── ECMA-335 metadata reader ────────────────────────────────────────────────

const T = {
  Module: 0x00, TypeRef: 0x01, TypeDef: 0x02, FieldPtr: 0x03, Field: 0x04, MethodPtr: 0x05, MethodDef: 0x06,
  ParamPtr: 0x07, Param: 0x08, InterfaceImpl: 0x09, MemberRef: 0x0a, Constant: 0x0b, CustomAttribute: 0x0c,
  FieldMarshal: 0x0d, DeclSecurity: 0x0e, ClassLayout: 0x0f, FieldLayout: 0x10, StandAloneSig: 0x11, EventMap: 0x12,
  EventPtr: 0x13, Event: 0x14, PropertyMap: 0x15, PropertyPtr: 0x16, Property: 0x17, MethodSemantics: 0x18,
  MethodImpl: 0x19, ModuleRef: 0x1a, TypeSpec: 0x1b, ImplMap: 0x1c, FieldRVA: 0x1d, EncLog: 0x1e, EncMap: 0x1f,
  Assembly: 0x20, AssemblyProcessor: 0x21, AssemblyOS: 0x22, AssemblyRef: 0x23, AssemblyRefProcessor: 0x24,
  AssemblyRefOS: 0x25, File: 0x26, ExportedType: 0x27, ManifestResource: 0x28, NestedClass: 0x29,
  GenericParam: 0x2a, MethodSpec: 0x2b, GenericParamConstraint: 0x2c,
};
const CODED = {
  TypeDefOrRef: [2, [T.TypeDef, T.TypeRef, T.TypeSpec]],
  HasConstant: [2, [T.Field, T.Param, T.Property]],
  HasCustomAttribute: [5, [T.MethodDef, T.Field, T.TypeRef, T.TypeDef, T.Param, T.InterfaceImpl, T.MemberRef, T.Module, T.DeclSecurity, T.Property, T.Event, T.StandAloneSig, T.ModuleRef, T.TypeSpec, T.Assembly, T.AssemblyRef, T.File, T.ExportedType, T.ManifestResource, T.GenericParam, T.GenericParamConstraint, T.MethodSpec]],
  HasFieldMarshal: [1, [T.Field, T.Param]],
  HasDeclSecurity: [2, [T.TypeDef, T.MethodDef, T.Assembly]],
  MemberRefParent: [3, [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec]],
  HasSemantics: [1, [T.Event, T.Property]],
  MethodDefOrRef: [1, [T.MethodDef, T.MemberRef]],
  MemberForwarded: [1, [T.Field, T.MethodDef]],
  Implementation: [2, [T.File, T.AssemblyRef, T.ExportedType]],
  CustomAttributeType: [3, [-1, -1, T.MethodDef, T.MemberRef, -1]],
  ResolutionScope: [2, [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef]],
  TypeOrMethodDef: [1, [T.TypeDef, T.MethodDef]],
};
// column kinds: "2" u2, "4" u4, "1" u1+pad→u2, "s" string, "g" guid, "b" blob, number = table index, string = coded
const SCHEMA = {
  [T.Module]: ["2", "s", "g", "g", "g"],
  [T.TypeRef]: ["ResolutionScope", "s", "s"],
  [T.TypeDef]: ["4", "s", "s", "TypeDefOrRef", T.Field, T.MethodDef],
  [T.FieldPtr]: [T.Field],
  [T.Field]: ["2", "s", "b"],
  [T.MethodPtr]: [T.MethodDef],
  [T.MethodDef]: ["4", "2", "2", "s", "b", T.Param],
  [T.ParamPtr]: [T.Param],
  [T.Param]: ["2", "2", "s"],
  [T.InterfaceImpl]: [T.TypeDef, "TypeDefOrRef"],
  [T.MemberRef]: ["MemberRefParent", "s", "b"],
  [T.Constant]: ["2", "HasConstant", "b"],
  [T.CustomAttribute]: ["HasCustomAttribute", "CustomAttributeType", "b"],
  [T.FieldMarshal]: ["HasFieldMarshal", "b"],
  [T.DeclSecurity]: ["2", "HasDeclSecurity", "b"],
  [T.ClassLayout]: ["2", "4", T.TypeDef],
  [T.FieldLayout]: ["4", T.Field],
  [T.StandAloneSig]: ["b"],
  [T.EventMap]: [T.TypeDef, T.Event],
  [T.EventPtr]: [T.Event],
  [T.Event]: ["2", "s", "TypeDefOrRef"],
  [T.PropertyMap]: [T.TypeDef, T.Property],
  [T.PropertyPtr]: [T.Property],
  [T.Property]: ["2", "s", "b"],
  [T.MethodSemantics]: ["2", T.MethodDef, "HasSemantics"],
  [T.MethodImpl]: [T.TypeDef, "MethodDefOrRef", "MethodDefOrRef"],
  [T.ModuleRef]: ["s"],
  [T.TypeSpec]: ["b"],
  [T.ImplMap]: ["2", "MemberForwarded", "s", T.ModuleRef],
  [T.FieldRVA]: ["4", T.Field],
  [T.EncLog]: ["4", "4"],
  [T.EncMap]: ["4"],
  [T.Assembly]: ["4", "2", "2", "2", "2", "4", "b", "s", "s"],
  [T.AssemblyProcessor]: ["4"],
  [T.AssemblyOS]: ["4", "4", "4"],
  [T.AssemblyRef]: ["2", "2", "2", "2", "4", "b", "s", "s", "b"],
  [T.AssemblyRefProcessor]: ["4", T.AssemblyRef],
  [T.AssemblyRefOS]: ["4", "4", "4", T.AssemblyRef],
  [T.File]: ["4", "s", "b"],
  [T.ExportedType]: ["4", "4", "s", "s", "Implementation"],
  [T.ManifestResource]: ["4", "4", "s", "Implementation"],
  [T.NestedClass]: [T.TypeDef, T.TypeDef],
  [T.GenericParam]: ["2", "2", "TypeOrMethodDef", "s"],
  [T.MethodSpec]: ["MethodDefOrRef", "b"],
  [T.GenericParamConstraint]: [T.GenericParam, "TypeDefOrRef"],
};

function readMetadata(file) {
  const buf = readFileSync(file);
  const u16 = (o) => buf.readUInt16LE(o);
  const u32 = (o) => buf.readUInt32LE(o);
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) throw new Error("not a PE file");
  const coff = pe + 4;
  const nSections = u16(coff + 2);
  const optSize = u16(coff + 16);
  const opt = coff + 20;
  const magic = u16(opt);
  const dd = opt + (magic === 0x20b ? 112 : 96);
  const cliRva = u32(dd + 14 * 8);
  const sections = [];
  for (let i = 0; i < nSections; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ va: u32(s + 12), vsize: u32(s + 8), raw: u32(s + 20), rawSize: u32(s + 16) });
  }
  const off = (rva) => {
    for (const s of sections) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return rva - s.va + s.raw;
    throw new Error(`rva ${rva} outside sections`);
  };
  const cli = off(cliRva);
  const mdRoot = off(u32(cli + 8));
  if (u32(mdRoot) !== 0x424a5342) throw new Error("no metadata");
  const verLen = u32(mdRoot + 12);
  let p = mdRoot + 16 + verLen + 2;
  const nStreams = u16(p);
  p += 2;
  const streams = {};
  for (let i = 0; i < nStreams; i++) {
    const o = u32(p);
    const size = u32(p + 4);
    let name = "";
    let q = p + 8;
    while (buf[q]) name += String.fromCharCode(buf[q++]);
    q++;
    p = q + ((4 - ((q - (p + 8)) % 4)) % 4);
    streams[name] = { off: mdRoot + o, size };
  }
  const tbl = streams["#~"] ?? streams["#-"];
  const heapSizes = buf[tbl.off + 6];
  const valid = buf.readBigUInt64LE(tbl.off + 8);
  const rows = new Array(64).fill(0);
  let rp = tbl.off + 24;
  for (let i = 0; i < 64; i++) if ((valid >> BigInt(i)) & 1n) {
    rows[i] = u32(rp);
    rp += 4;
  }
  const strIdx = heapSizes & 1 ? 4 : 2;
  const guidIdx = heapSizes & 2 ? 4 : 2;
  const blobIdx = heapSizes & 4 ? 4 : 2;
  const codedSize = (name) => {
    const [bits, tables] = CODED[name];
    const max = Math.max(...tables.map((t) => (t < 0 ? 0 : rows[t])));
    return max < 1 << (16 - bits) ? 2 : 4;
  };
  const colSize = (c) => (c === "2" || c === "1" ? 2 : c === "4" ? 4 : c === "s" ? strIdx : c === "g" ? guidIdx : c === "b" ? blobIdx : typeof c === "number" ? (rows[c] < 0x10000 ? 2 : 4) : codedSize(c));
  const tables = {};
  let tp = rp;
  for (let i = 0; i < 64; i++) {
    if (!rows[i]) continue;
    const schema = SCHEMA[i];
    if (!schema) throw new Error(`unknown table 0x${i.toString(16)}`);
    const sizes = schema.map(colSize);
    const rowSize = sizes.reduce((a, b) => a + b, 0);
    tables[i] = { off: tp, rowSize, sizes, schema, rows: rows[i] };
    tp += rowSize * rows[i];
  }
  const read = (o, size) => (size === 2 ? u16(o) : u32(o));
  /** Row `r` (1-based) of table `t` as an array of raw column values. */
  const row = (t, r) => {
    const tb = tables[t];
    if (!tb || r < 1 || r > tb.rows) return null;
    let o = tb.off + (r - 1) * tb.rowSize;
    const out = [];
    for (const size of tb.sizes) {
      out.push(read(o, size));
      o += size;
    }
    return out;
  };
  const strings = streams["#Strings"];
  const str = (i) => {
    let o = strings.off + i;
    let e = o;
    while (buf[e]) e++;
    return buf.toString("utf8", o, e);
  };
  const blobs = streams["#Blob"];
  const blob = (i) => {
    let o = blobs.off + i;
    const b0 = buf[o];
    let len;
    if ((b0 & 0x80) === 0) {
      len = b0;
      o += 1;
    } else if ((b0 & 0xc0) === 0x80) {
      len = ((b0 & 0x3f) << 8) | buf[o + 1];
      o += 2;
    } else {
      len = ((b0 & 0x1f) << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
      o += 4;
    }
    return buf.subarray(o, o + len);
  };
  const decodeCoded = (name, v) => {
    const [bits, tableList] = CODED[name];
    return { table: tableList[v & ((1 << bits) - 1)], index: v >> bits };
  };
  return { rows, row, str, blob, decodeCoded, tables };
}

// ── model per assembly ──────────────────────────────────────────────────────

const VIS_PUBLIC = 1;
const VIS_NESTED_PUBLIC = 2;

function loadAssembly(file) {
  const md = readMetadata(file);
  const nTypes = md.rows[T.TypeDef];
  const nested = new Map(); // typedef row → enclosing row
  for (let r = 1; r <= md.rows[T.NestedClass]; r++) {
    const [n, e] = md.row(T.NestedClass, r);
    nested.set(n, e);
  }
  const tdName = (r) => {
    const [, name, ns] = md.row(T.TypeDef, r);
    const enc = nested.get(r);
    if (enc) return `${tdName(enc)}.${md.str(name)}`;
    const n = md.str(ns);
    return n ? `${n}.${md.str(name)}` : md.str(name);
  };
  const trName = (r) => {
    const [scope, name, ns] = md.row(T.TypeRef, r);
    const s = md.decodeCoded("ResolutionScope", scope);
    if (s.table === T.TypeRef && s.index) return `${trName(s.index)}.${md.str(name)}`;
    const n = md.str(ns);
    return n ? `${n}.${md.str(name)}` : md.str(name);
  };
  // generic parameter names per owner
  const typeGen = new Map();
  const methGen = new Map();
  for (let r = 1; r <= md.rows[T.GenericParam]; r++) {
    const [num, , owner, name] = md.row(T.GenericParam, r);
    const o = md.decodeCoded("TypeOrMethodDef", owner);
    const map = o.table === T.TypeDef ? typeGen : methGen;
    const list = map.get(o.index) ?? [];
    list[num] = md.str(name);
    map.set(o.index, list);
  }
  const stripArity = (n) => n.replace(/`\d+/g, "");

  // signature type decoding → C#-shaped FQN text
  const PRIM = { 0x01: "System.Void", 0x02: "System.Boolean", 0x03: "System.Char", 0x04: "System.SByte", 0x05: "System.Byte", 0x06: "System.Int16", 0x07: "System.UInt16", 0x08: "System.Int32", 0x09: "System.UInt32", 0x0a: "System.Int64", 0x0b: "System.UInt64", 0x0c: "System.Single", 0x0d: "System.Double", 0x0e: "System.String", 0x18: "System.IntPtr", 0x19: "System.UIntPtr", 0x1c: "System.Object", 0x16: "System.TypedReference" };
  const typeName = (coded, ctx) => {
    const tag = coded & 3;
    const idx = coded >> 2;
    if (tag === 0) return stripArity(tdName(idx));
    if (tag === 1) return stripArity(trName(idx));
    return typeSpec(idx, ctx);
  };
  const typeSpec = (idx, ctx) => {
    const [b] = md.row(T.TypeSpec, idx);
    const r = new Reader(md.blob(b));
    return sigType(r, ctx);
  };
  function sigType(r, ctx) {
    let e = r.u8();
    while (e === 0x1f || e === 0x20) {
      r.compressed();
      e = r.u8();
    }
    if (PRIM[e]) return PRIM[e];
    switch (e) {
      case 0x0f:
      case 0x10:
      case 0x45:
        return sigType(r, ctx);
      case 0x11:
      case 0x12:
        return typeName(r.compressed(), ctx);
      case 0x13: {
        const n = r.compressed();
        return ctx.typeParams?.[n] ?? `!${n}`;
      }
      case 0x1e:
        return `!!${r.compressed()}`;
      case 0x1d:
        return `${sigType(r, ctx)}[]`;
      case 0x14: {
        const el = sigType(r, ctx);
        const rank = r.compressed();
        const ns = r.compressed();
        for (let i = 0; i < ns; i++) r.compressed();
        const nl = r.compressed();
        for (let i = 0; i < nl; i++) r.compressed();
        return `${el}[${",".repeat(Math.max(0, rank - 1))}]`;
      }
      case 0x15: {
        r.u8(); // CLASS / VALUETYPE
        const base = typeName(r.compressed(), ctx);
        const n = r.compressed();
        const args = [];
        for (let i = 0; i < n; i++) args.push(sigType(r, ctx));
        return `${base}<${args.join(",")}>`;
      }
      case 0x1b:
        return "System.IntPtr";
      default:
        return "?";
    }
  }

  const types = {};
  const fieldEnd = (r) => (r < nTypes ? md.row(T.TypeDef, r + 1)[4] : md.rows[T.Field] + 1);
  const methodEnd = (r) => (r < nTypes ? md.row(T.TypeDef, r + 1)[5] : md.rows[T.MethodDef] + 1);
  const propRanges = new Map();
  for (let r = 1; r <= md.rows[T.PropertyMap]; r++) {
    const [parent, start] = md.row(T.PropertyMap, r);
    const end = r < md.rows[T.PropertyMap] ? md.row(T.PropertyMap, r + 1)[1] : md.rows[T.Property] + 1;
    propRanges.set(parent, [start, end]);
  }
  const eventRanges = new Map();
  for (let r = 1; r <= md.rows[T.EventMap]; r++) {
    const [parent, start] = md.row(T.EventMap, r);
    const end = r < md.rows[T.EventMap] ? md.row(T.EventMap, r + 1)[1] : md.rows[T.Event] + 1;
    eventRanges.set(parent, [start, end]);
  }
  const ifaces = new Map();
  for (let r = 1; r <= md.rows[T.InterfaceImpl]; r++) {
    const [cls, iface] = md.row(T.InterfaceImpl, r);
    const list = ifaces.get(cls) ?? [];
    list.push(iface);
    ifaces.set(cls, list);
  }

  const isVisible = (r) => {
    const flags = md.row(T.TypeDef, r)[0];
    const vis = flags & 7;
    if (vis === VIS_PUBLIC) return true;
    if (vis === VIS_NESTED_PUBLIC) return isVisible(nested.get(r));
    return false;
  };

  for (let r = 2; r <= nTypes; r++) {
    if (!isVisible(r)) continue;
    const [flags, , , extendsCoded, fieldStart, methodStart] = md.row(T.TypeDef, r);
    const full = tdName(r); // with `n arity suffixes
    const gp = typeGen.get(r) ?? [];
    const ctx = { typeParams: gp };
    const isInterface = (flags & 0x20) !== 0;
    const base = extendsCoded ? typeName(extendsCoded, ctx) : undefined;
    let k = isInterface ? "interface" : "class";
    if (base === "System.ValueType") k = "struct";
    if (base === "System.Enum") k = "enum";
    if (base === "System.MulticastDelegate") k = "delegate";
    // `Outer\`2.Inner` → `Outer.Inner\`2`: arity suffixes moved to the end, counting
    // every generic parameter in scope (a nested type of a generic type inherits them)
    const key = `${stripArity(full)}${gp.length ? `\`${gp.length}` : ""}`;
    const t = { k };
    if (base && base !== "System.Object" && base !== "System.ValueType" && base !== "System.Enum") t.b = base;
    const ifs = (ifaces.get(r) ?? []).map((c) => typeName(c, ctx)).filter((x) => x !== "?");
    if (ifs.length) t.i = ifs.sort();
    if (gp.length) t.g = gp;
    const m = {};
    const vm = [];
    // fields
    for (let f = fieldStart; f < fieldEnd(r); f++) {
      const [ff, name, sig] = md.row(T.Field, f);
      const access = ff & 7;
      if (access !== 6) continue; // public
      const rd = new Reader(md.blob(sig));
      rd.u8(); // 0x06
      const ft = sigType(rd, ctx);
      m[md.str(name)] = { t: ft, k: ff & 0x40 ? "c" : "f", ...(ff & 0x10 ? { s: 1 } : {}) };
    }
    // methods (first public overload per name; getters/setters come with properties)
    for (let mi = methodStart; mi < methodEnd(r); mi++) {
      const [, , mf, name, sig] = md.row(T.MethodDef, mi);
      const access = mf & 7;
      const nm = md.str(name);
      const overridable = (mf & 0x40) !== 0 && (mf & 0x20) === 0; // virtual and not final
      if (overridable && (access === 6 || access === 4 || access === 5) && !(mf & 0x800)) vm.push(nm);
      if (access !== 6 || mf & 0x800) continue;
      const rd = new Reader(md.blob(sig));
      const cc = rd.u8();
      const generic = (cc & 0x10) !== 0;
      if (generic) rd.compressed(); // generic param count
      rd.compressed(); // param count
      const ret = sigType(rd, { typeParams: gp });
      // one entry per name: the first non-generic overload's return type, plus the
      // generic overload's (`GetComponent<T>()` → !!0) when one exists
      const prev = m[nm];
      if (!prev) m[nm] = generic ? { t: ret, tg: ret, k: "m", ...(mf & 0x10 ? { s: 1 } : {}) } : { t: ret, k: "m", ...(mf & 0x10 ? { s: 1 } : {}) };
      else if (prev.k === "m") {
        if (generic && !prev.tg) prev.tg = ret;
        if (!generic && prev.t === prev.tg) prev.t = ret;
      }
    }
    // properties (public getter)
    const pr = propRanges.get(r);
    if (pr) for (let pi = pr[0]; pi < pr[1]; pi++) {
      const [, name, sig] = md.row(T.Property, pi);
      const nm = md.str(name);
      if (m[nm]) continue;
      // public if a public get_<name> exists among this type's methods
      let isPublic = false;
      let isStatic = false;
      for (let mi = methodStart; mi < methodEnd(r); mi++) {
        const [, , mf, mname] = md.row(T.MethodDef, mi);
        if (md.str(mname) === `get_${nm}` && (mf & 7) === 6) {
          isPublic = true;
          isStatic = (mf & 0x10) !== 0;
          break;
        }
      }
      if (!isPublic) continue;
      const rd = new Reader(md.blob(sig));
      rd.u8();
      rd.compressed();
      m[nm] = { t: sigType(rd, ctx), k: "p", ...(isStatic ? { s: 1 } : {}) };
    }
    // events
    const er = eventRanges.get(r);
    if (er) for (let ei = er[0]; ei < er[1]; ei++) {
      const [, name, et] = md.row(T.Event, ei);
      const nm = md.str(name);
      if (!m[nm]) m[nm] = { t: typeName(et, ctx), k: "e" };
    }
    if (Object.keys(m).length) t.m = Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
    if (vm.length) t.vm = [...new Set(vm)].sort();
    // namespace of the outermost declaring type (for filtering; dropped on output)
    let outer = r;
    while (nested.get(outer)) outer = nested.get(outer);
    Object.defineProperty(t, "ns", { value: md.str(md.row(T.TypeDef, outer)[2]), enumerable: false });
    types[key] = t;
  }
  return types;
}

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.o = 0;
  }
  u8() {
    return this.buf[this.o++];
  }
  compressed() {
    const b0 = this.buf[this.o];
    if ((b0 & 0x80) === 0) {
      this.o += 1;
      return b0;
    }
    if ((b0 & 0xc0) === 0x80) {
      const v = ((b0 & 0x3f) << 8) | this.buf[this.o + 1];
      this.o += 2;
      return v;
    }
    const v = ((b0 & 0x1f) << 24) | (this.buf[this.o + 1] << 16) | (this.buf[this.o + 2] << 8) | this.buf[this.o + 3];
    this.o += 4;
    return v;
  }
}

// ── messages (ScriptReference 6000.6, by hand — no assembly declares them) ───

const MESSAGES = {
  "UnityEngine.MonoBehaviour": [
    "Awake", "FixedUpdate", "LateUpdate", "OnAnimatorIK", "OnAnimatorMove", "OnApplicationFocus", "OnApplicationPause",
    "OnApplicationQuit", "OnAudioFilterRead", "OnBecameInvisible", "OnBecameVisible", "OnChildRectTransformDimensionsChange",
    "OnCollisionEnter", "OnCollisionEnter2D", "OnCollisionExit", "OnCollisionExit2D", "OnCollisionStay", "OnCollisionStay2D",
    "OnControllerColliderHit", "OnDestroy", "OnDisable", "OnDrawGizmos", "OnDrawGizmosSelected", "OnEnable", "OnGUI",
    "OnJointBreak", "OnJointBreak2D", "OnMouseDown", "OnMouseDrag", "OnMouseEnter", "OnMouseExit", "OnMouseOver", "OnMouseUp",
    "OnMouseUpAsButton", "OnParticleCollision", "OnParticleSystemStopped", "OnParticleTrigger", "OnParticleUpdateJobScheduled",
    "OnPostRender", "OnPreCull", "OnPreRender", "OnRenderImage", "OnRenderObject", "OnTransformChildrenChanged",
    "OnTransformParentChanged", "OnTriggerEnter", "OnTriggerEnter2D", "OnTriggerExit", "OnTriggerExit2D", "OnTriggerStay",
    "OnTriggerStay2D", "OnValidate", "OnWillRenderObject", "Reset", "Start", "Update",
  ],
  "UnityEngine.ScriptableObject": ["Awake", "OnDestroy", "OnDisable", "OnEnable", "OnValidate", "Reset"],
  "UnityEditor.EditorWindow": [
    "Awake", "CreateGUI", "OnBecameInvisible", "OnBecameVisible", "OnDestroy", "OnFocus", "OnGUI", "OnHierarchyChange",
    "OnInspectorUpdate", "OnLostFocus", "OnProjectChange", "OnSelectionChange", "Update",
  ],
  "UnityEditor.Editor": ["HasFrameBounds", "OnFrameBounds", "OnSceneGUI"],
  "UnityEditor.AssetPostprocessor": [
    "OnAssignMaterialModel", "OnPostprocessAllAssets", "OnPostprocessAnimation", "OnPostprocessAssetbundleNameChanged",
    "OnPostprocessAudio", "OnPostprocessCubemap", "OnPostprocessGameObjectWithAnimatedUserProperties",
    "OnPostprocessGameObjectWithUserProperties", "OnPostprocessMaterial", "OnPostprocessMeshHierarchy", "OnPostprocessModel",
    "OnPostprocessPrefab", "OnPostprocessSpeedTree", "OnPostprocessSprites", "OnPostprocessTexture",
    "OnPostprocessTexture2DArray", "OnPostprocessTexture3D", "OnPreprocessAnimation", "OnPreprocessAsset", "OnPreprocessAudio",
    "OnPreprocessCameraDescription", "OnPreprocessLightDescription", "OnPreprocessMaterialDescription", "OnPreprocessModel",
    "OnPreprocessSpeedTree", "OnPreprocessTexture",
  ],
};
const MESSAGE_SOURCES = [
  "https://docs.unity3d.com/6000.6/Documentation/ScriptReference/MonoBehaviour.html",
  "https://docs.unity3d.com/6000.6/Documentation/ScriptReference/ScriptableObject.html",
  "https://docs.unity3d.com/6000.6/Documentation/ScriptReference/EditorWindow.html",
  "https://docs.unity3d.com/6000.6/Documentation/ScriptReference/Editor.html",
  "https://docs.unity3d.com/6000.6/Documentation/ScriptReference/AssetPostprocessor.html",
];

// ── main ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : "src/graph/data/unity-api.json";
const contents = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--out") ?? join(homedir(), "Library/Application Support/GameForge/unity-editors/claude/Unity.app/Contents");
const managed = join(contents, "Resources/Scripting/Managed/UnityEngine");
const netstandard = join(contents, "Resources/Scripting/NetStandard/ref/2.1.0/netstandard.dll");
if (!existsSync(managed)) {
  console.error(`✗ no editor reference assemblies at ${managed}`);
  process.exit(1);
}
const BCL_NAMESPACES = /^System(\.Collections(\.Generic|\.ObjectModel|\.Concurrent)?|\.Linq|\.Threading\.Tasks|\.Text|\.IO)?$/;
const types = {};
const dlls = readdirSync(managed).filter((f) => f.endsWith(".dll") && /^Unity(Engine|Editor)/.test(f)).sort();
for (const dll of dlls) {
  try {
    Object.assign(types, loadAssembly(join(managed, dll)));
  } catch (err) {
    console.error(`  skip ${dll}: ${err.message}`);
  }
}
if (existsSync(netstandard)) {
  const bcl = loadAssembly(netstandard);
  for (const [k, v] of Object.entries(bcl)) {
    if (BCL_NAMESPACES.test(v.ns)) types[k] = v;
  }
}
// attribute types (transitively derived from System.Attribute)
const isAttr = (k, depth = 0) => {
  const t = types[k];
  if (!t || depth > 12) return false;
  if (t.b === "System.Attribute") return true;
  return t.b ? isAttr(t.b.replace(/<.*$/, ""), depth + 1) : false;
};
const attributes = Object.keys(types).filter((k) => isAttr(k)).sort();
const version = /(\d{4}\.\d+\.\d+[a-z]\d+)/.exec(readFileSync(join(contents, "Info.plist"), "utf8"))?.[1] ?? "unknown";
const sorted = Object.fromEntries(Object.entries(types).sort(([a], [b]) => a.localeCompare(b)));
const data = {
  source: `Unity ${version} reference assemblies (${dlls.length} UnityEngine/UnityEditor modules) + .NET Standard 2.1 netstandard.dll, via scripts/gen-unity-api.mjs; messages from ${MESSAGE_SOURCES.join(", ")}`,
  types: sorted,
  messages: MESSAGES,
  attributes,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(data));
console.log(`✓ ${Object.keys(sorted).length} types, ${attributes.length} attributes → ${out} (${(JSON.stringify(data).length / 1e6).toFixed(1)} MB)`);
