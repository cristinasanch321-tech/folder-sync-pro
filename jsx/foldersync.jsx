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

/* coloca UN archivo en UN bin. Nunca borra. v4.8: import individual + move inmediato */
function placeFile(mp, bin, res, err) {
    var under = pathsUnder(bin);
    if (under[mp]) { res.moved++; return; }
    var it = findItemByMediaPath(mp);
    if (!it) {
        var ok = false;
        try { ok = app.project.importFiles([mp], true, bin, true); } catch (eI) { ok = false; }
        var under2 = pathsUnder(bin);
        if (under2[mp]) { res.imported++; res.moved++; return; }
        // fallback: import simple (via manual)
        ok = false;
        try { ok = app.project.importFiles([mp]); } catch (eI2) { ok = false; }
        it = findItemByMediaPath(mp);
        if (!it) {
            res.rejected.push(mp);
            err("RECHAZADO por Premiere: " + mp.split("/").pop());
            return;
        }
    }
    if (itemInBin(bin, it)) { res.imported++; res.moved++; return; }
    var done = false;
    try {
        if (typeof it.moveIntoBin === "function") {
            it.moveIntoBin(bin);
            if (itemInBin(bin, it)) done = true;
        }
    } catch (eM) {}
    if (!done) { try { if (it.move && it.move(bin) === 0 && itemInBin(bin, it)) done = true; } catch (eM2) {} }
    if (done) { res.relocated++; res.moved++; }
    else res.failed.push("raiz: " + it.name);
}

/* payload: { ops: [ { files: [...], binPath: [...] } ] } — v4.8: uno a uno */
function FS_import(batchJson) {
    var res = { ok: false, imported: 0, moved: 0, relocated: 0, rejected: [], failed: [], errors: [] };
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
                    catch (eF) { err("archivo: " + eF); }
                }
            } catch (eOp) { err("op " + i + ": " + eOp); }
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

/* ---- v4.7: TEST de metodos de movimiento ---- */
function FS_testMove() {
    var res = { ok: true, results: [] };
    try {
        if (!app.project) { res.results.push("No hay proyecto"); return J(res); }
        // crear bin de prueba
        var testBin = null;
        try { testBin = app.project.rootItem.createBin("TEST_MOVE_" + Date.now()); } catch (e0) { testBin = null; }
        if (!testBin) { res.results.push("createBin: FALLO"); return J(res); }
        res.results.push("createBin: OK");
        // crear un archivo de prueba WAV en /tmp
        var testFile = new File(Folder.temp.fsName + "/autocut_test_move.wav");
        // generar un WAV minimo valido (44 bytes header + 1s silencio 48k mono 16bit)
        var sr = 48000, n = sr;
        var f = new File(testFile.fsName);
        f.encoding = "BINARY";
        f.open("w");
        var dataSize = n * 2;
        var buf = [];
        function w4(s) { for (var i = 0; i < 4; i++) buf.push(s.charCodeAt(i)); }
        function w32(v) { buf.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >> 24) & 255); }
        function w16(v) { buf.push(v & 255, (v >> 8) & 255); }
        w4("RIFF"); w32(36 + dataSize); w4("WAVE");
        w4("fmt "); w32(16); w16(1); w16(1); w32(sr); w32(sr * 2); w16(2); w16(16);
        w4("data"); w32(dataSize);
        for (var i = 0; i < n; i++) w16(0);
        var s = "";
        for (var b = 0; b < buf.length; b += 32768) s += String.fromCharCode.apply(null, buf.slice(b, b + 32768));
        f.write(s);
        f.close();
        // importarlo a la raiz
        var before = {};
        (function walk(bin) {
            var nn = bin.children.numItems;
            for (var i2 = 0; i2 < nn; i2++) {
                var c2 = bin.children[i2];
                if (c2.type === ProjectItemType.BIN) { walk(c2); continue; }
                var mp2 = "";
                try { mp2 = c2.getMediaPath(); } catch (e2) {}
                if (mp2) before[mp2] = 1;
            }
        })(app.project.rootItem);
        try { app.project.importFiles([testFile.fsName]); } catch (eI) {}
        var found = null;
        (function walk2(bin) {
            if (found) return;
            var nn = bin.children.numItems;
            for (var i3 = 0; i3 < nn; i3++) {
                var c3 = bin.children[i3];
                if (c3.type === ProjectItemType.BIN) { walk2(c3); continue; }
                var mp3 = "";
                try { mp3 = c3.getMediaPath(); } catch (e3) {}
                if (mp3 === testFile.fsName) { found = c3; return; }
            }
        })(app.project.rootItem);
        if (!found) { res.results.push("import del test: FALLO (no aparecio)"); testBin.remove(); testFile.remove(); return J(res); }
        res.results.push("import a raiz: OK");
        // METODO 1: moveIntoBin
        var m1 = "moveIntoBin: ";
        try {
            var r1 = found.moveIntoBin(testBin);
            var in1 = false;
            for (var q = 0; q < testBin.children.numItems; q++) if (testBin.children[q].nodeId === found.nodeId) in1 = true;
            m1 += in1 ? "FUNCIONA" : "fallo (r=" + r1 + ", no esta dentro)";
        } catch (e1) { m1 += "EXCEPCION " + e1; }
        res.results.push(m1);
        // METODO 2: move(bin)
        var in2 = false;
        try {
            var r2 = found.move(testBin);
            for (var q2 = 0; q2 < testBin.children.numItems; q2++) if (testBin.children[q2].nodeId === found.nodeId) in2 = true;
            res.results.push("move(bin): " + (in2 ? "FUNCIONA" : "fallo (r=" + r2 + ")"));
        } catch (e2) { res.results.push("move(bin): EXCEPCION " + e2); }
        // METODO 3: move con path de bin? (algunas versiones aceptan itemId)
        // limpiar: quitar el item de test y el bin de test y el archivo
        try { found.remove(false, false); } catch (eR) {}
        try { testBin.remove(); } catch (eR2) {}
        try { testFile.remove(); } catch (eR3) {}
        res.results.push("(test limpiado: sin dejar basura)");
        return J(res);
    } catch (e) { res.results.push("FATAL: " + e.toString()); return J(res); }
}

/* ---- v5: import al bin seleccionado en el panel Proyecto ---- */
function FS_getSelectedBin() {
    var res = { ok: false };
    try {
        if (!app.project) { res.error = "No hay proyecto"; return J(res); }
        var sel = null;
        try { sel = app.project.activeItem; } catch (e0) {}
        // activeItem no existe en PPro; deteccion alternativa: buscar bin "seleccionado" no es posible.
        // Por eso el flujo real: el usuario dice el bin por NOMBRE y nosotros lo localizamos.
        res.ok = true;
        return J(res);
    } catch (e) { res.error = e.toString(); return J(res); }
}

/* importa archivos a raiz (via simple) y devuelve lista de nombres+mediaPath
   para que el panel sepa exactamente que acaba de entrar (aunque caiga en raiz) */
function FS_importSimple(paths) {
    var res = { ok: false, importedNames: [], rejected: [] };
    try {
        if (!app.project) { res.error = "No hay proyecto"; return J(res); }
        var before = {};
        (function walk(bin) {
            var n = bin.children.numItems;
            for (var i = 0; i < n; i++) {
                var c = bin.children[i];
                if (c.type === ProjectItemType.BIN) { walk(c); continue; }
                var mp = "";
                try { mp = c.getMediaPath(); } catch (e) {}
                if (mp) before[mp] = 1;
            }
        })(app.project.rootItem);
        try { app.project.importFiles(paths); } catch (eI) {}
        var found = {};
        (function walk2(bin) {
            var n = bin.children.numItems;
            for (var i = 0; i < n; i++) {
                var c = bin.children[i];
                if (c.type === ProjectItemType.BIN) { walk2(c); continue; }
                var mp = "";
                try { mp = c.getMediaPath(); } catch (e2) {}
                if (mp && !before[mp]) found[mp] = c.name;
            }
        })(app.project.rootItem);
        // SOLO los que existen de verdad en el proyecto; los demas = rechazados
        for (var k = 0; k < paths.length; k++) {
            if (found[paths[k]]) {
                res.importedNames.push({ name: found[paths[k]], path: paths[k] });
            } else {
                res.rejected.push(paths[k]);
            }
        }
        // rechazados = pedidos que no aparecieron
        for (var k = 0; k < paths.length; k++) {
            var appeared = false;
            for (var j = 0; j < res.importedNames.length; j++) {
                if (res.importedNames[j].path === paths[k]) { appeared = true; break; }
            }
            if (!appeared) res.rejected.push(paths[k]);
        }
        res.ok = true;
        return J(res);
    } catch (e) { res.error = e.toString(); return J(res); }
}
