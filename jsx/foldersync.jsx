/* FolderSync Pro v3 - jsx/foldersync.jsx
   Importacion con destino REAL: app.project.importFiles(files, true, bin, true)
   + verificacion (el item debe quedar DENTRO del bin) + reubicacion de extraviados. */

function J(o) {
    var t = typeof o, k, i;
    if (o === null) return "null";
    if (t === "number") return (isNaN(o) || !isFinite(o)) ? "0" : String(o);
    if (t === "boolean") return String(o);
    if (t === "string") return '"' + o.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                                       .replace(/\n/g, "\\n").replace(/\r/g, "") + '"';
    if (o instanceof Array) {
        var a = [];
        for (i = 0; i < o.length; i++) a.push(J(o[i]));
        return "[" + a.join(",") + "]";
    }
    var p = [];
    for (k in o) if (o.hasOwnProperty(k)) p.push('"' + k + '":' + J(o[k]));
    return "{" + p.join(",") + "}";
}

function FS_ping() {
    try {
        var p = app.project ? app.project.name : null;
        if (!p) return J({ ok: false, error: "No hay proyecto abierto" });
        return J({ ok: true, project: p });
    } catch (e) { return J({ ok: false, error: String(e) }); }
}

function FS_pickFolder() {
    try {
        var f = Folder.selectDialog("Elige la carpeta a vigilar");
        if (!f) return J({ ok: false, canceled: true });
        return J({ ok: true, path: f.fsName, name: f.name });
    } catch (e) { return J({ ok: false, error: String(e) }); }
}

function isBin(item) {
    try { return item.type === ProjectItemType.BIN; } catch (e) { return false; }
}

function findChildBin(bin, name, createIfMissing) {
    var n = bin.children.numItems;
    for (var i = 0; i < n; i++) {
        var c = bin.children[i];
        if (isBin(c) && c.name.toLowerCase() === String(name).toLowerCase()) return c;
    }
    if (createIfMissing) { try { return bin.createBin(name); } catch (e) { return null; } }
    return null;
}

function ensureBinPath(pathArr) {
    var cur = app.project.rootItem;
    for (var i = 0; i < pathArr.length; i++) {
        if (!pathArr[i]) continue;
        cur = findChildBin(cur, pathArr[i], true);
        if (!cur) throw new Error("No se pudo crear el bin: " + pathArr[i]);
    }
    return cur;
}

function snapSet() {
    var s = {};
    (function walk(bin) {
        var n = bin.children.numItems;
        for (var i = 0; i < n; i++) {
            var c = bin.children[i];
            if (isBin(c)) { walk(c); continue; }
            var mp = "";
            try { mp = c.getMediaPath(); } catch (e) {}
            if (mp) s[mp] = 1; else s["name:" + c.name] = 1;
        }
    })(app.project.rootItem);
    return s;
}

function pathsUnder(bin) {
    var s = {};
    (function walk(b) {
        var n = b.children.numItems;
        for (var i = 0; i < n; i++) {
            var c = b.children[i];
            if (isBin(c)) { walk(c); continue; }
            var mp = "";
            try { mp = c.getMediaPath(); } catch (e) {}
            if (mp) s[mp] = 1;
        }
    })(bin);
    return s;
}

function findItemByMediaPath(mp) {
    var found = null;
    (function walk(bin) {
        if (found) return;
        var n = bin.children.numItems;
        for (var i = 0; i < n; i++) {
            var c = bin.children[i];
            if (isBin(c)) { walk(c); if (found) return; continue; }
            var p = "";
            try { p = c.getMediaPath(); } catch (e) {}
            if (mp.indexOf("name:") === 0 ? ("name:" + c.name) === mp : p === mp) { found = c; return; }
        }
    })(app.project.rootItem);
    return found;
}

function itemInBin(bin, item) {
    var n = bin.children.numItems;
    for (var i = 0; i < n; i++) {
        if (bin.children[i].nodeId === item.nodeId) return true;
    }
    return false;
}

function FS_listBins() {
    try {
        var out = [];
        (function walk(bin, pathArr) {
            var n = bin.children.numItems;
            for (var i = 0; i < n; i++) {
                var c = bin.children[i];
                if (isBin(c)) {
                    var p = pathArr.concat([c.name]);
                    out.push(p);
                    walk(c, p);
                }
            }
        })(app.project.rootItem, []);
        return J({ ok: true, bins: out });
    } catch (e) { return J({ ok: false, error: String(e) }); }
}

/* trae/un coloca UN archivo en UN bin. Nunca borra. */
function placeFile(mp, bin, res, err) {
    var under = pathsUnder(bin);
    if (under[mp]) { res.moved++; return; }            // ya esta dentro
    var it = findItemByMediaPath(mp);
    if (!it) {                                          // no existe en el proyecto: importar AL bin
        var ok = false;
        try { ok = app.project.importFiles([mp], true, bin, true); } catch (eI) { ok = false; }
        if (!ok) { try { ok = app.project.importFiles([mp]); } catch (eI2) { ok = false; } }
        var under2 = pathsUnder(bin);
        if (under2[mp]) { res.imported++; res.moved++; return; }
        it = findItemByMediaPath(mp);
        if (!it) { res.failed.push("no importable: " + mp); return; }
    }
    if (itemInBin(bin, it)) { res.imported++; res.moved++; return; }
    var done = false;
    try {
        if (typeof it.moveIntoBin === "function") {
            var r = it.moveIntoBin(bin);
            if (itemInBin(bin, it)) done = true;
        }
    } catch (eM) {}
    if (!done) { try { if (it.move && it.move(bin) === 0 && itemInBin(bin, it)) done = true; } catch (eM2) {} }
    if (done) { res.relocated++; res.moved++; }
    else res.failed.push("quedo fuera del bin: " + it.name);
}

/* payload: { ops: [ { files: [...], binPath: [...] } ] } */
function FS_import(batchJson) {
    var res = { ok: false, imported: 0, moved: 0, relocated: 0, failed: [], errors: [] };
    function err(m) { res.errors.push(String(m)); }
    try {
        if (!app.project) { err("No hay proyecto abierto"); return J(res); }
        var batch = eval("(" + batchJson + ")");
        if (!batch.ops || !batch.ops.length) { res.ok = true; return J(res); }
        for (var i = 0; i < batch.ops.length; i++) {
            var op = batch.ops[i];
            if (!op.files || !op.files.length) continue;
            try {
                var bin = ensureBinPath(op.binPath || []);
                for (var f = 0; f < op.files.length; f++) {
                    try { placeFile(op.files[f], bin, res, err); }
                    catch (eF) { err("archivo " + op.files[f] + ": " + eF); }
                }
            } catch (eOp) { err("op " + i + ": " + eOp); }
        }
        res.ok = true;
        return J(res);
    } catch (e) { res.errors.push("FATAL: " + e.toString()); return J(res); }
}

/* payload: { groups: [ { files: [...], binPath: [...] } ] } — solo anade, NUNCA borra */
function FS_sync(batchJson) {
    var res = { ok: false, imported: 0, moved: 0, relocated: 0, failed: [], errors: [] };
    function err(m) { res.errors.push(String(m)); }
    try {
        if (!app.project) { err("No hay proyecto abierto"); return J(res); }
        var batch = eval("(" + batchJson + ")");
        var groups = batch.groups || [];
        for (var g = 0; g < groups.length; g++) {
            var gr = groups[g];
            if (!gr.files || !gr.files.length) continue;
            try {
                var bin = ensureBinPath(gr.binPath || []);
                for (var f = 0; f < gr.files.length; f++) {
                    try { placeFile(gr.files[f], bin, res, err); }
                    catch (eF) { err("archivo " + gr.files[f] + ": " + eF); }
                }
            } catch (eG) { err("grupo " + g + ": " + eG); }
        }
        res.ok = true;
        return J(res);
    } catch (e) { res.errors.push("FATAL: " + e.toString()); return J(res); }
}

/* ---- v4.3: deteccion de media offline (condicion del dialogo Vincular medio) ---- */
function FS_checkOffline() {
    var res = { ok: true, offline: 0, names: [] };
    try {
        if (!app.project) { res.ok = false; return J(res); }
        (function walk(bin) {
            var n = bin.children.numItems;
            for (var i = 0; i < n; i++) {
                var c = bin.children[i];
                if (isBin(c)) { walk(c); continue; }
                var off = false;
                try { off = c.isMediaOffline(); } catch (e1) {}
                if (off) {
                    res.offline++;
                    if (res.names.length < 5) { try { res.names.push(c.name); } catch (e3) {} }
                }
            }
        })(app.project.rootItem);
        return J(res);
    } catch (e) { res.error = String(e); return J(res); }
}
