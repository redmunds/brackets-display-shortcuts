/*
 * Copyright (c) 2012 Randy Edmunds, Adobe Systems Incorporated. All rights reserved.
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
/*global define, brackets, $, Mustache, CodeMirror, _showShortcuts */

define(function (require, exports, module) {
    "use strict";
    
    // Brackets modules
    var CommandManager      = brackets.getModule("command/CommandManager"),
        DocumentManager     = brackets.getModule("document/DocumentManager"),
        EditorManager       = brackets.getModule("editor/EditorManager"),
        ExtensionUtils      = brackets.getModule("utils/ExtensionUtils"),
        KeyBindingManager   = brackets.getModule("command/KeyBindingManager"),
        Menus               = brackets.getModule("command/Menus"),
        PanelManager        = brackets.getModule("view/PanelManager"),
        PreferencesManager  = brackets.getModule("preferences/PreferencesManager");

    var panelHtml           = require("text!templates/bottom-panel.html"),
        shortcutsHtml       = require("text!templates/shortcut-table.html"),
        TOGGLE_SHORTCUTS_ID = "redmunds.show-shortcuts.view.shortcuts",
        keyList = [],
        loaded = false,
        panel,
        togglePanelShortcut = [{
            // Note: Brackets will write error message to console
            // about key "Cmd-Alt-/" already being registered on mac.
            key: "Ctrl-Alt-/"
        }, {
            // Define key again explicitly for mac to prevent Brackets
            // from converting Ctrl to Cmd.
            key: "Ctrl-Alt-/",
            platform: "mac"
        }],
        $filterField,
        currentFilter;

    var sortByBase = 1,
        sortByBinding = 2,
        sortByCmdId = 3,
        sortByCmdName = 4,
        sortByOrig = 5,
        sortColumn = sortByBase,
        sortAscending = true;

    var origBrackets = "Brackets",
        origCodeMirror = "CodeMirror",
        origExtension = "Extension";

    // Determine base key by stripping modifier keys
    function _getBaseKey(keyBinding) {
        var keyBase = keyBinding
            .replace(/Ctrl-/, "")
            .replace(/Shift-/, "")
            .replace(/Alt-/, "");
        if (brackets.platform === "mac") {
            keyBase = keyBase.replace(/Cmd-/, "");
        }
        return keyBase;
    }

    function _findKeyBinding(kl, keyBinding) {
        var j;
        for (j = 0; j < kl.length; j++) {
            if (keyBinding === kl[j].keyBinding) {
                return j;
            }
        }
        return -1;
    }

    function _ucFirst(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    // "ReloadInBrowser" => "Reload In Browser"
    // "extension_manager" => "Extension Manager"
    function _humanizeString(string) {
        // Replace "foo_bar" with "foo bar" and "FooBar" with " Foo Bar"
        string = string.replace(/_/g, " ").replace(/([A-Z])/g, " $1");
        // Trim whitespace
        string = string.replace(/(^\s+)/, "").replace(/(\s+$)/, "");
        // Split words by whitespace, uppercase the first letter, join with a space
        string = string.split(/\s+/).map(_ucFirst).join(" ");

        return string;
    }

    function _getOriginFromCommandId(cmdID) {
        // According to CommandManager.register() documentation:
        //  Core commands in Brackets use a simple command title as an id, for example "open.file".
        //  Extensions should use the following format: "author.myextension.mycommandname". 
        //  For example, "lschmitt.csswizard.format.css".
        var idArray = cmdID.split(".");
        if (idArray.length > 2) {
            // more than two qualifiers
            return origExtension + " (" + _humanizeString(idArray[1]) + ")";
        } else if (idArray.length < 2) {
            // less than two qualifiers
            return origExtension;
        }

        // check for a brackets menu
        var q1 = idArray[0].toLowerCase();
        if (q1 === "file" || q1 === "edit" || q1 === "view" || q1 === "navigate" || q1 === "debug" || q1 === "help") {
            return origBrackets;
        }

        // must be an extension
        return origExtension;
    }

    // CodeMirror and Brackets key maps have different formats, so collect
    // keys into a normalized array
    function _getkeyList() {
        var i,
            base,
            command,
            key;

        // Brackets keymap
        var bracketsKeymap = KeyBindingManager.getKeymap();
        if (bracketsKeymap) {
            for (i in bracketsKeymap) {
                if (bracketsKeymap.hasOwnProperty(i)) {
                    key = bracketsKeymap[i];
                    if (key) {
                        base = _getBaseKey(i);
                        command = CommandManager.get(key.commandID);
                        keyList.push({
                            keyBase: base,
                            keyBinding: i,
                            commandID: key.commandID,
                            commandName: command.getName(),
                            origin: _getOriginFromCommandId(key.commandID),
                            filter: command.getName().toLowerCase()
                        });
                    }
                }
            }
        }

        // CodeMirror keymap
        if (CodeMirror.keyMap) {
            var cmKeymap = (brackets.platform === "mac")
                ? CodeMirror.keyMap.macDefault : CodeMirror.keyMap.pcDefault;
            if (cmKeymap) {
                for (i in cmKeymap) {
                    // Note that we only ignore CodeMirror duplicates, but
                    // we want to see Brackets & Extensions duplicates
                    if (cmKeymap.hasOwnProperty(i) &&
                            (i !== "fallthrough") &&
                            (_findKeyBinding(keyList, i) === -1)) {
                        base = _getBaseKey(i);
                        keyList.push({
                            keyBase: base,
                            keyBinding: i,
                            commandID: cmKeymap[i],
                            commandName: cmKeymap[i],
                            origin: origCodeMirror,
                            filter: cmKeymap[i].toLowerCase()
                        });
                    }
                }
            }
        }
        
        return keyList;
    }

    function _strcmp(a, b) {
        if (a < b) {
            return (sortAscending ? -1 : 1);
        } else if (a > b) {
            return (sortAscending ? 1 : -1);
        }
        return 0;
    }

    function _stricmp(a, b) {
        return _strcmp(a.toLowerCase(), b.toLowerCase());
    }

    function _keyBaseSort(a, b) {
        // First sort by whether it's a single char or not, so letters are separated from key
        // names (e.g. Backspace). Then sort by base key, finally key binding string
        var a2 = ((a.keyBase.length === 1) ? "0" : "1") + a.keyBase,
            b2 = ((b.keyBase.length === 1) ? "0" : "1") + b.keyBase,
            c = _strcmp(a2, b2);

        if (c !== 0) {
            return c;
        } else {
            return _strcmp(a.keyBinding, b.keyBinding);
        }
    }

    function _keyBindingSort(a, b) {
        return _strcmp(a.keyBinding, b.keyBinding);
    }

    function _keyCmdIdSort(a, b) {
        return _stricmp(a.commandID, b.commandID);
    }

    function _keyCmdNameSort(a, b) {
        return _strcmp(a.commandName, b.commandName);
    }

    function _keyOrigSort(a, b) {
        return _strcmp(a.origin, b.origin);
    }

    function _getSortFunc() {
        if (sortColumn === sortByBinding) {
            return _keyBindingSort;
        } else if (sortColumn === sortByCmdId) {
            return _keyCmdIdSort;
        } else if (sortColumn === sortByCmdName) {
            return _keyCmdNameSort;
        } else if (sortColumn === sortByOrig) {
            return _keyOrigSort;
        }
        return _keyBaseSort;
    }

    function _getShortcutsHtml() {
        var msData = {};
        msData.keyList = keyList.sort(_getSortFunc());
        return Mustache.render(shortcutsHtml, msData);
    }

    function _changeSorting(newSortColumn) {
        if (newSortColumn === sortColumn) {
            // Same column, so change sort direction
            sortAscending = !sortAscending;
        } else {
            // New sort column
            sortColumn = newSortColumn;
        }
        
        // Update page
        _showShortcuts();
    }

    function _filterShortcuts(forceFiltering) {
        var terms = $filterField.val().trim().toLocaleLowerCase();
        if (forceFiltering || terms !== currentFilter) {
            currentFilter = terms;
            terms = terms.split(/\s+?/);
            $.each(keyList, function (i, key) {
                var match;
                if (terms === "") {
                    match = true;
                } else {
                    $.each(terms, function (i, term) {
                        if (match !== false) {
                            match = key.filter.indexOf(term) > -1;
                        }
                    });
                }
                key.filterMatch = match;
            });
        }
    }

    function _showShortcuts() {
        var $shortcuts = $("#shortcuts");
        
        // Apply any active filter
        _filterShortcuts(true);

        // Add new markup
        $shortcuts.find(".resizable-content").html(_getShortcutsHtml());
        $shortcuts.find("thead th").eq(sortColumn - 1).addClass('sort-' + (sortAscending ? 'ascending' : 'descending'));

        // Setup header sort buttons
        $("thead .shortcut-base a", $shortcuts).on("click", function () {
            _changeSorting(sortByBase);
        });
        $("thead .shortcut-binding a", $shortcuts).on("click", function () {
            _changeSorting(sortByBinding);
        });
        $("thead .shortcut-cmd-id a", $shortcuts).on("click", function () {
            _changeSorting(sortByCmdId);
        });
        $("thead .shortcut-cmd-name a", $shortcuts).on("click", function () {
            _changeSorting(sortByCmdName);
        });
        $("thead .shortcut-orig a", $shortcuts).on("click", function () {
            _changeSorting(sortByOrig);
        });
    }

    function _handleShowHideShortcuts() {
        if (panel.isVisible()) {
            // This panel probably won't get opened very often, so only maintain data
            // while panel is open (for faster sorting) and discard when closed.
            keyList = [];
            panel.hide();
            CommandManager.get(TOGGLE_SHORTCUTS_ID).setChecked(false);
            EditorManager.focusEditor();
        } else {
            panel.show();
            CommandManager.get(TOGGLE_SHORTCUTS_ID).setChecked(true);
            $filterField.val("").focus();

            // Only get data once while panel is open
            if (keyList.length === 0) {
                keyList = _getkeyList();
            }
            _showShortcuts();
        }
        EditorManager.resizeEditor();
    }

    function _copyTableToCurrentDoc() {

        var editor = EditorManager.getCurrentFullEditor();
        if (!editor) {
            return;
        }

        var instance = editor._codeMirror;
        if (!instance) {
            return;
        }
        
        var start = instance.getCursor(true),
            end   = instance.getCursor(false);

        instance.replaceRange(_getShortcutsHtml(), start, end);
    }

    function init() {
        var $shortcutsPanel,
            $shortcutsContent,
            s,
            view_menu;

        ExtensionUtils.loadStyleSheet(module, "shortcuts.css");

        // Register function as command
        CommandManager.register("Show Shortcuts", TOGGLE_SHORTCUTS_ID, _handleShowHideShortcuts);

        // Add command to View menu, if it exists
        view_menu = Menus.getMenu(Menus.AppMenuBar.VIEW_MENU);
        if (view_menu) {
            view_menu.addMenuItem(TOGGLE_SHORTCUTS_ID, togglePanelShortcut);
        }

        // Add the HTML UI
        s = Mustache.render(panelHtml);

        // AppInit.htmlReady() has already executed before extensions are loaded
        // so, for now, we need to call this ourself
        panel = PanelManager.createBottomPanel(TOGGLE_SHORTCUTS_ID, $(s), 100);
        panel.hide();

        $shortcutsPanel = $("#shortcuts");
        $shortcutsContent = $shortcutsPanel.find(".resizable-content");

        $shortcutsPanel.find(".copy-table").click(function () {
            _copyTableToCurrentDoc();
        });

        $shortcutsPanel.find(".close").click(function () {
            CommandManager.execute(TOGGLE_SHORTCUTS_ID);
        });

        $filterField = $shortcutsPanel.find(".toolbar .filter");
        $filterField.on("keyup", _showShortcuts);
    }

    init();
});
