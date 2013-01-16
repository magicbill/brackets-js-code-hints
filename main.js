/*
 * Copyright (c) 2012 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, brackets, CodeMirror, $, Worker */

define(function (require, exports, module) {
    "use strict";

    var CodeHintManager         = brackets.getModule("editor/CodeHintManager"),
        DocumentManager         = brackets.getModule("document/DocumentManager"),
        EditorManager           = brackets.getModule("editor/EditorManager"),
        EditorUtils             = brackets.getModule("editor/EditorUtils"),
        FileUtils               = brackets.getModule("file/FileUtils"),
        NativeFileSystem        = brackets.getModule("file/NativeFileSystem").NativeFileSystem,
        AppInit                 = brackets.getModule("utils/AppInit"),
        Scope                   = require("scope").Scope,
        KEYWORDS                = require("token").KEYWORDS;

    var MODE_NAME = "javascript",
        EVENT_TAG = "brackets-js-hints",
        SCOPE_MSG_TYPE = "outerScope";

    var sessionEditor       = null,  // editor object for the current hinting session
        $deferredHintObj    = null,  // deferred hint object
        innerScopePending   = null,  // was an inner scope request delayed waiting for an outer scope?
        innerScopeDirty     = true,  // has the outer scope changed since the last inner scope request?
        innerScope          = null,  // the inner-most scope returned by the query worker
        identifiers         = null,  // identifiers in the local scope
        properties          = null,  // properties sorted by position
        allGlobals          = {},    // path -> list of all global variables
        allIdentifiers      = {},    // path -> list of all identifiers
        allProperties       = {},    // path -> list of all properties
        outerScope          = {},    // path -> outer-most scope
        outerScopeDirty     = {},    // path -> has the path changed since the last outer scope request? 
        outerWorkerActive   = {},    // path -> is the outer worker active for the path? 
        outerScopeWorker    = (function () {
            var path = module.uri.substring(0, module.uri.lastIndexOf("/") + 1);
            return new Worker(path + "parser-worker.js");
        }());

    /**
     * Creates a hint response object
     */
    function _getHintObj() {

        /*
         * Get the token before the one at the given cursor
         */
        function getPreviousToken(cm, cursor, token) {
            var doc = sessionEditor.document;

            if (token.start >= 0) {
                return cm.getTokenAt({ch: token.start,
                                      line: cursor.line});
            } else if (cursor.line > 0) {
                return cm.getTokenAt({ch: doc.getLine(cursor.line - 1).length - 1,
                                      line: cursor.line - 1});
            }
            
            return null;
        }

        /**
         * Calculate a query string relative to the current cursor position
         * and token.
         */
        function getQuery(cursor, token, prevToken, nextToken) {
            var query = "";
            if (token) {
                if (token.string !== ".") {
                    query = token.string.substring(0, token.string.length - (token.end - cursor.ch));
                }
            }
            return query.trim();
        }

        /*
         * Filter a list of tokens using a given query string
         */
        function filterWithQuery(tokens, query) {
            var hints = tokens.filter(function (token) {
                    return (token.value.indexOf(query) === 0);
                });

            return hints;
        }

        /*
         * Returns a formatted list of hints with the query substring highlighted
         */
        function formatHints(hints, query) {
            return hints.map(function (token) {
                var hint = token.value,
                    index = hint.indexOf(query),
                    $hintObj = $('<span>');

                if (index >= 0) {
                    $hintObj.append(hint.slice(0, index))
                        .append($('<span>')
                                .append(hint.slice(index, index + query.length))
                                .css('font-weight', 'bold'))
                        .append(hint.slice(index + query.length));
                } else {
                    $hintObj.text(hint);
                }
                $hintObj.data('hint', hint);

                switch (token.level) {
                case 0:
                    $hintObj.css('color', 'rgb(0,100,0)');
                    break;
                case 1:
                    $hintObj.css('color', 'rgb(100,100,0)');
                    break;
                case 2:
                    $hintObj.css('color', 'rgb(0,0,100)');
                    break;
                }

                return $hintObj;
            });
        }

        var cursor = sessionEditor.getCursorPos(),
            cm = sessionEditor._codeMirror,
            token = cm.getTokenAt(cursor),
            prevToken = getPreviousToken(cm, cursor, token),
            query = getQuery(cursor, token),
            hints;

//        console.log("Token: '" + token.string + "'");
//        console.log("Prev: '" + (prevToken ? prevToken.string : "(null)") + "'");
//        console.log("Query: '" + query + "'");
        
        if ((token && (token.string === "." || token.className === "property")) ||
                (prevToken && prevToken.string.indexOf(".") >= 0)) {
            hints = filterWithQuery(properties, query);
        } else {
            hints = filterWithQuery(identifiers, query);
        }

        // Truncate large hint lists for performance reasons
        hints = hints.slice(0, 100);
        
        return {
            hints: formatHints(hints, query),
            match: null,
            selectInitial: true
        };
    }

    /**
     * Request a new outer scope object from the parser worker, if necessary
     */
    function _refreshOuterScope(path) {

        if (!outerScope.hasOwnProperty(path)) {
            outerScope[path] = null;
        }

        if (!outerScopeDirty.hasOwnProperty(path)) {
            outerScopeDirty[path] = true;
        }
        
        if (!outerWorkerActive.hasOwnProperty(path)) {
            outerWorkerActive[path] = false;
        }
       
        // if there is not yet an outer scope or if the file has changed then
        // we might need to update the outer scope
        if (outerScope[path] === null || outerScopeDirty[path]) {
            if (!outerWorkerActive[path]) {
                console.log("Requesting parse: " + path);
                // and maybe if some time has passed without parsing... 
                outerWorkerActive[path] = true; // the outer scope worker is active
                outerScopeDirty[path] = false; // the file is clean since the last outer scope request
                FileUtils.readAsText(new NativeFileSystem.FileEntry(path)).done(function (text) {
                    outerScopeWorker.postMessage({
                        type        : SCOPE_MSG_TYPE,
                        path        : path,
                        text        : text,
                        force       : !outerScope[path]
                    });
                });
            } else {
                console.log("Already parsing: " + path);
            }
        }
    }

    /**
     * Recompute the inner scope for a given offset, if necessary
     */
    function _refreshInnerScope(path, offset) {

        /*
         * Filter a list of tokens using a given scope object
         */
        function filterByScope(tokens, scope) {
            return tokens.filter(function (id) {
                var level = scope.contains(id.value);
                if (level >= 0) {
                    id.level = level;
                    return true;
                } else {
                    return false;
                }
            });
        }

        /*
         * Comparator for sorting tokens according to minimum distance from
         * a given position
         */
        function compareByPosition(pos) {
            function mindist(pos, t) {
                var dist = t.positions.length ? Math.abs(t.positions[0] - pos) : Infinity,
                    i,
                    tmp;

                for (i = 1; i < t.positions.length; i++) {
                    tmp = Math.abs(t.positions[i] - pos);
                    if (tmp < dist) {
                        dist = tmp;
                    }
                }
                return dist;
            }

            return function (a, b) {
                return mindist(pos, a) - mindist(pos, b);
            };
        }

        /*
         * Comparator for sorting tokens lexicographically according to scope
         * and then minimum distance from a given position
         */
        function compareByScope(scope) {
            return function (a, b) {
                var adepth = scope.contains(a.value);
                var bdepth = scope.contains(b.value);

                if (adepth === bdepth) {
                    // sort symbols at the same scope depth
                    return 0;
                } else if (adepth !== null && bdepth !== null) {
                    return adepth - bdepth;
                } else {
                    if (adepth === null) {
                        return bdepth;
                    } else {
                        return adepth;
                    }
                }
            };
        }
        
        /*
         * Comparator for sorting tokens by name
         */
        function compareByName(a, b) {
            return a.value < b.value;
        }
        
        /*
         * Comparator for sorting tokens by path, such that
         * a <= b if a.path === path
         */
        function compareByPath(path) {
            return function (a, b) {
                if (a.path === path) {
                    if (b.path === path) {
                        return 0;
                    } else {
                        return -1;
                    }
                } else {
                    if (b.path === path) {
                        return 1;
                    } else {
                        return 0;
                    }
                }
            };
        }
        
        /*
         * Forms the lexicographical composition of comparators
         */
        function lexicographic(compare1, compare2) {
            return function (a, b) {
                var result = compare1(a, b);
                if (result === 0) {
                    return compare2(a, b);
                } else {
                    return result;
                }
            };
        }
        
        /*
         * A comparator for identifiers
         */
        function compareIdentifiers(scope, pos) {
            return lexicographic(compareByScope(scope), compareByPosition(pos));
        }
        
        function compareProperties(path) {
            return lexicographic(compareByPath(path),
                                 lexicographic(compareByPosition(offset),
                                               compareByName));
        }
        
        function mergeProperties(properties, path, offset) {
            var uniqueprops = {},
                otherprops = [],
                otherpath,
                propname;
            
            function addin(token) {
                if (!Object.prototype.hasOwnProperty.call(uniqueprops, token.value)) {
                    uniqueprops[token.value] = token;
                }
            }
            
            properties.forEach(addin);
            
            for (otherpath in allProperties) {
                if (allProperties.hasOwnProperty(otherpath)) {
                    if (otherpath !== path) {
                        allProperties[otherpath].forEach(addin);
                    }
                }
            }
            
            for (propname in uniqueprops) {
                if (Object.prototype.hasOwnProperty.call(uniqueprops, propname)) {
                    otherprops.push(uniqueprops[propname]);
                }
            }
            
            return otherprops.sort(compareProperties(path));
        }

        // if there is not yet an inner scope, or if the outer scope has 
        // changed, or if the inner scope is invalid w.r.t. the current cursor
        // position we might need to update the inner scope
        if (innerScope === null || innerScopeDirty ||
                !innerScope.containsPositionImmediate(offset)) {

            if (outerScope[path] === null) {
                innerScopePending = offset;
                _refreshOuterScope(path);
            } else {
                if (outerWorkerActive[path]) {
                    innerScopePending = offset;
                } else {
                    innerScopePending = null;
                }
                innerScopeDirty = false;
                
                innerScope = outerScope[path].findChild(offset);
                if (innerScope) {
                    // FIXME: This could be more efficient if instead of filtering
                    // the entire list of identifiers we just used the identifiers
                    // in the scope of innerScope, but that list doesn't have the
                    // accumulated position information.
                    identifiers = filterByScope(allIdentifiers[path], innerScope);
                    identifiers.sort(compareIdentifiers(innerScope, offset));
                    properties = mergeProperties(allProperties[path].slice(0), path, offset);
                } else {
                    identifiers = [];
                    properties = [];
                }
                identifiers = identifiers.concat(allGlobals[path]);
                identifiers = identifiers.concat(KEYWORDS);

                if ($deferredHintObj !== null &&
                        $deferredHintObj.state() === "pending") {
                    $deferredHintObj.resolveWith(null, [_getHintObj()]);
                }
                
                $deferredHintObj = null;
            }
        }
    }

    function _refreshFile(path) {
        var parent  = path.substring(0, path.lastIndexOf("/")),
            dir     = new NativeFileSystem.DirectoryEntry(parent),
            reader  = dir.createReader();
        
        reader.readEntries(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isFile &&
                        entry.fullPath.lastIndexOf(".js") === entry.fullPath.length - 3) {
                    _refreshOuterScope(entry.fullPath);
                }
            });
        }, function (err) {
            console.log("Unable to refresh directory: " + err);
            _refreshOuterScope(path);
        });
    }

    /**
     * Reset and recompute the scope and hinting information for the given
     * editor
     */
    function _refreshEditor(editor) {
        var path = editor.document.file.fullPath;

        if (!sessionEditor ||
                sessionEditor.document.file.fullPath !== path) {
            // allGlobals = null;
            // allProperties = null;
            // allIdentifiers = null;
            identifiers = null;
            properties = null;
            innerScope = null;
            // outerScope[path] = null;
            outerScopeDirty[path] = true;
            // innerScopeDirty[path] = true;
        }
        sessionEditor = editor;

        if ($deferredHintObj && $deferredHintObj.state() === "pending") {
            $deferredHintObj.reject();
        }
        $deferredHintObj = null;

        _refreshFile(path);
    }

    /**
     * Is the string key perhaps a valid JavaScript identifier?
     */
    function _maybeIdentifier(key) {
        return (/[0-9a-z_.\$]/i).test(key);
    }

    /**
     * Is the token's class hintable?
     */
    function _hintableTokenClass(token) {
        switch (token.className) {
        case "string":
        case "comment":
        case "number":
        case "regexp":
            return false;
        default:
            return true;
        }
    }

    /**
     * @constructor
     */
    function JSHints() {
    }

    JSHints.prototype.hasHints = function (editor, key) {

        /*
         * Compute the cursor's offset from the beginning of the document
         */
        function _cursorOffset(document, cursor) {
            var offset = 0,
                i;

            for (i = 0; i < cursor.line; i++) {
                // +1 for the removed line break
                offset += document.getLine(i).length + 1;
            }
            offset += cursor.ch;
            return offset;
        }

        if ((key === null) || _maybeIdentifier(key)) {
            var cursor      = editor.getCursorPos(),
                token       = editor._codeMirror.getTokenAt(cursor),
                path,
                offset;

            // don't autocomplete within strings or comments, etc.
            if (token && _hintableTokenClass(token)) {
                path = sessionEditor.document.file.fullPath;
                offset = _cursorOffset(sessionEditor.document, cursor);
                _refreshInnerScope(path, offset);
                return true;
            }
        }
        return false;
    };

    /** 
      * Return a list of hints, possibly deferred, for the current editor 
      * context
      */
    JSHints.prototype.getHints = function (key) {
        if ((key === null) || _maybeIdentifier(key)) {
            var cursor = sessionEditor.getCursorPos(),
                token  = sessionEditor._codeMirror.getTokenAt(cursor);

            if (token && _hintableTokenClass(token)) {
                var path = sessionEditor.document.file.fullPath;
                if (outerScope[path]) {
                    return _getHintObj();
                } else {
                    if (!$deferredHintObj || $deferredHintObj.isRejected()) {
                        $deferredHintObj = $.Deferred();
                    }
                    return $deferredHintObj;
                }
            }
        }

        return null;
    };

    /**
     * Enters the code completion text into the editor
     * 
     * @param {string} hint - text to insert into current code editor
     */
    JSHints.prototype.insertHint = function (hint) {

        /*
         * Get the token after the one at the given cursor
         */
        function getNextToken(cm, cursor) {
            var doc = sessionEditor.document,
                line = doc.getLine(cursor.line);

            if (cursor.ch < line.length) {
                return cm.getTokenAt({ch: cursor.ch + 1,
                                      line: cursor.line});
            } else if (doc.getLine(cursor.line + 1)) {
                return cm.getTokenAt({ch: 0, line: cursor.line + 1});
            } else {
                return null;
            }
        }

        var completion = hint.data('hint'),
            cm = sessionEditor._codeMirror,
            path = sessionEditor.document.file.fullPath,
            cursor = sessionEditor.getCursorPos(),
            token = cm.getTokenAt(cursor),
            nextToken = getNextToken(cm, cursor),
            start = {line: cursor.line, ch: token.start},
            end = {line: cursor.line, ch: token.end};

        if (token.string === "." || token.string.trim() === "") {
            if (nextToken.string.trim() === "" || !_hintableTokenClass(nextToken)) {
                start.ch = cursor.ch;
                end.ch = cursor.ch;
            } else {
                start.ch = nextToken.start;
                end.ch = nextToken.end;
            }
        }

        cm.replaceRange(completion, start, end);
        outerScopeDirty[path] = true;
        return false;
    };

    // load the extension
    AppInit.appReady(function () {

        /*
         * Receive an outer scope object from the parser worker
         */
        function handleOuterScope(response) {
            var path = response.path;

            outerWorkerActive[path] = false;
            if (response.success) {
                var fileEntry = new NativeFileSystem.FileEntry(path);
                
                FileUtils.readAsText(fileEntry).done(function (text) { // FIXME maybe just return the text length? 
                    outerScope[path] = new Scope(response.scope);
                    // the outer scope should cover the entire file
                    outerScope[path].range.start = 0;
                    outerScope[path].range.end = text.length;
    
                    allGlobals[path] = response.globals;
                    allIdentifiers[path] = response.identifiers;
                    allProperties[path] = response.properties.map(function (p) {
                        p.path = path;
                        return p;
                    });
                    innerScopeDirty = true;
    
                    if (outerScopeDirty[path]) {
                        _refreshOuterScope(path);
                    }
    
                    if (innerScopePending !== null) {
                        _refreshInnerScope(path, innerScopePending);
                    }
                });
            }
        }

        /*
         * Install editor change listeners to keep the outer scope fresh
         */
        function installEditorListeners(editor) {
            if (!editor) {
                return;
            }
            
            var path = editor.document.file.fullPath;

            if (editor.getModeForSelection() === "javascript") {
                $(editor)
                    .on("change." + EVENT_TAG, function () {
                        outerScopeDirty[path] = true;
                        _refreshOuterScope(path);
                    });

                _refreshEditor(editor);
            }
        }

        /*
         * Uninstall editor change listeners
         */
        function uninstallEditorListeners(editor) {
            $(editor)
                .off("change." + EVENT_TAG);
        }

        outerScopeWorker.addEventListener("message", function (e) {
            var response = e.data,
                type = response.type;

            if (type === SCOPE_MSG_TYPE) {
                handleOuterScope(response);
            } else {
                console.log("Worker: " + (response.log || response));
            }
        });

        // uninstall/install change listener as the active editor changes
        $(EditorManager)
            .on("activeEditorChange." + EVENT_TAG,
                function (event, current, previous) {
                    uninstallEditorListeners(previous);
                    installEditorListeners(current);
                });
        
        installEditorListeners(EditorManager.getActiveEditor());

        var jsHints = new JSHints();
        CodeHintManager.registerHintProvider(jsHints, ["javascript"], 0);

        // for unit testing
        exports.jsHintProvider = jsHints;
    });
});
