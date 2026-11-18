-- WowDeck: shares the action bar layout and keybindings with the WoW-Deck plugin.
--
-- Addons cannot talk to other programs, so the export lives in SavedVariables (WowDeckDB),
-- which the game writes to WTF/Account/<account>/SavedVariables/WowDeck.lua on /reload,
-- logout or disconnect. The plugin watches that file.
--
-- For every occupied action slot the export says what is on it and which key fires it:
--   * the player's own keyboard binding for that bar button, when there is one; otherwise
--   * a reserved "deck chord" the addon binds (override binding) to a hidden secure button
--     that fires exactly that slot. Chords already bound to anything are never used.

local EXPORT_VERSION = 2
local MAX_SLOT = 180

-- The extra bars, their binding commands, and the button frame names the UI may use for them.
-- Their action slots are read from the frames at runtime (clients number bars 6-8 differently);
-- `first` is only a fallback for bars 2-5, whose slots are the same everywhere.
local BAR_FRAMES = {
    { name = "Bottom left bar", command = "MULTIACTIONBAR1BUTTON", first = 61, frames = { "MultiBarBottomLeftButton", "MultiBarBottomLeftActionButton" } },
    { name = "Bottom right bar", command = "MULTIACTIONBAR2BUTTON", first = 49, frames = { "MultiBarBottomRightButton", "MultiBarBottomRightActionButton" } },
    { name = "Right bar", command = "MULTIACTIONBAR3BUTTON", first = 25, frames = { "MultiBarRightButton", "MultiBarRightActionButton" } },
    { name = "Right bar 2", command = "MULTIACTIONBAR4BUTTON", first = 37, frames = { "MultiBarLeftButton", "MultiBarLeftActionButton" } },
    { name = "Action bar 6", command = "MULTIACTIONBAR5BUTTON", frames = { "MultiBar5Button", "MultiBar5ActionButton" } },
    { name = "Action bar 7", command = "MULTIACTIONBAR6BUTTON", frames = { "MultiBar6Button", "MultiBar6ActionButton" } },
    { name = "Action bar 8", command = "MULTIACTIONBAR7BUTTON", frames = { "MultiBar7Button", "MultiBar7ActionButton" } },
}

local slotCommands = {} -- action slot -> binding command, e.g. 157 -> "MULTIACTIONBAR6BUTTON1"
local barList = {} -- bars as the plugin should list them: { name, first }

local function frameSlot(button)
    local action = button.action
    if (not action or action == 0) and button.GetAttribute then
        action = button:GetAttribute("action")
    end
    action = tonumber(action)
    return (action and action > 0) and action or nil
end

-- Reads which action slot each bar button shows. Slots 1-12 use the main bar buttons, which
-- follow stance/form paging just like pressing the key in game.
local function mapBars()
    slotCommands = {}
    barList = { { name = "Main bar", first = 1 } }
    for i = 1, 12 do
        slotCommands[i] = "ACTIONBUTTON" .. i
    end
    for _, bar in ipairs(BAR_FRAMES) do
        local first
        for i = 1, 12 do
            local slot
            for _, prefix in ipairs(bar.frames) do
                local button = _G[prefix .. i]
                slot = button and frameSlot(button)
                if slot then
                    break
                end
            end
            slot = slot or (bar.first and bar.first + i - 1)
            if slot then
                slotCommands[slot] = bar.command .. i
                first = first or (slot - i + 1)
            end
        end
        if first then
            barList[#barList + 1] = { name = bar.name, first = first }
        end
    end
end

-- Candidate chords for slots without a keyboard binding, most obscure first. Function keys come
-- before the numpad, whose keys can behave differently depending on NumLock.
local CHORD_POOL = {}
do
    local prefixes = { "CTRL-ALT-SHIFT-", "CTRL-ALT-", "ALT-SHIFT-" }
    for _, prefix in ipairs(prefixes) do
        for i = 1, 12 do CHORD_POOL[#CHORD_POOL + 1] = prefix .. "F" .. i end
    end
    for _, prefix in ipairs(prefixes) do
        for i = 0, 9 do CHORD_POOL[#CHORD_POOL + 1] = prefix .. "NUMPAD" .. i end
    end
end

local owner = CreateFrame("Frame", "WowDeckBindingOwner")
local slotButtons = {}
local currentChords = {}
local appliedSignature = nil -- user bindings + occupied slots the chords were assigned for
local savedSignature = nil -- export as of login, i.e. what the plugin can currently see
local pendingApply = false

local function spellName(id)
    if C_Spell and C_Spell.GetSpellName then
        return C_Spell.GetSpellName(id)
    end
    return (GetSpellInfo(id))
end

local function itemName(id)
    if C_Item and C_Item.GetItemNameByID then
        return C_Item.GetItemNameByID(id)
    end
    return (GetItemInfo(id))
end

local function bindingCommandForSlot(slot)
    return slotCommands[slot]
end

-- Mouse buttons and wheel bindings cannot be sent as keystrokes by the plugin.
local function isKeyboardKey(key)
    return key ~= nil and not key:find("BUTTON%d") and not key:find("MOUSEWHEEL")
end

local function userKeyForSlot(slot)
    local command = bindingCommandForSlot(slot)
    if not command then
        return nil
    end
    local key1, key2 = GetBindingKey(command)
    if isKeyboardKey(key1) then
        return key1
    end
    if isKeyboardKey(key2) then
        return key2
    end
    return nil
end

-- What chord assignment depends on: which slots are occupied and which have the player's keys.
local function bindingSignature()
    local parts = {}
    for slot = 1, MAX_SLOT do
        if HasAction(slot) then
            parts[#parts + 1] = slot .. "=" .. (userKeyForSlot(slot) or "")
        end
    end
    return table.concat(parts, ",")
end

local function slotButton(slot)
    local button = slotButtons[slot]
    if not button then
        button = CreateFrame("Button", "WowDeckSlot" .. slot, UIParent, "SecureActionButtonTemplate")
        button:SetAttribute("type", "action")
        button:SetAttribute("action", slot)
        button:Hide()
        slotButtons[slot] = button
    end
    -- Fire once per press, on whichever edge the player's own action buttons use.
    button:RegisterForClicks(GetCVarBool("ActionButtonUseKeyDown") and "AnyDown" or "AnyUp")
    return button
end

-- Assigns deck chords to occupied slots without a keyboard binding. Protected: out of combat only.
local function applyDeckBindings()
    if InCombatLockdown() then
        pendingApply = true
        return
    end
    pendingApply = false
    ClearOverrideBindings(owner)
    local chords, nextChord = {}, 1
    for slot = 1, MAX_SLOT do
        if HasAction(slot) and not userKeyForSlot(slot) then
            while CHORD_POOL[nextChord] and GetBindingAction(CHORD_POOL[nextChord], true) ~= "" do
                nextChord = nextChord + 1
            end
            local chord = CHORD_POOL[nextChord]
            if not chord then
                break -- pool exhausted; the player can still bind the remaining slots themselves
            end
            nextChord = nextChord + 1
            SetOverrideBindingClick(owner, true, chord, slotButton(slot):GetName(), "LeftButton")
            chords[slot] = chord
        end
    end
    currentChords = chords
    appliedSignature = bindingSignature()
end

-- Macro details: what it currently shows (spell or item) and the icon chosen for it.
local function describeMacro(slot, id, subType, entry)
    -- Newer clients report a macro that shows a spell/item as ("macro", spellOrItemID, "spell"/"item");
    -- older ones report ("macro", macroIndex).
    local index
    if subType == "spell" then
        entry.spellId = id
    elseif subType == "item" then
        entry.itemId = id
    else
        index = id
    end
    local actionText = GetActionText(slot)
    if not index and actionText and GetMacroIndexByName then
        index = GetMacroIndexByName(actionText)
        index = (index and index > 0) and index or nil
    end
    if index then
        local name, macroIcon = GetMacroInfo(index)
        entry.macroIndex = index
        entry.name = name
        entry.macroIcon = macroIcon -- the icon picked in the macro UI (question mark = dynamic)
        if not entry.spellId and not entry.itemId then
            -- #showtooltip macros resolve to a spell or item, which gives the plugin an icon.
            entry.spellId = GetMacroSpell and GetMacroSpell(index) or nil
            if not entry.spellId then
                local _, itemLink = GetMacroItem(index)
                entry.itemId = itemLink and tonumber(itemLink:match("item:(%d+)"))
            end
        end
    end
    entry.name = entry.name or actionText
end

local function describeSlot(slot)
    local kind, id, subType = GetActionInfo(slot)
    if not kind then
        return nil
    end
    -- `icon` is the texture file ID the game is displaying on the button right now, so it also
    -- mirrors macro icons, mounts, pets and anything else without a spell or item.
    local entry = { kind = kind, id = id, icon = GetActionTexture(slot) }
    if kind == "spell" then
        entry.name = spellName(id)
    elseif kind == "item" then
        entry.name = itemName(id)
    elseif kind == "macro" then
        describeMacro(slot, id, subType, entry)
    end
    entry.name = entry.name or GetActionText(slot)
    local key = userKeyForSlot(slot)
    entry.key = key or currentChords[slot]
    entry.keySource = key and "binding" or (currentChords[slot] and "deck" or nil)
    return entry
end

local function exportSignature(slots)
    local parts = {}
    for slot = 1, MAX_SLOT do
        local entry = slots[slot]
        if entry then
            parts[#parts + 1] = table.concat({ slot, entry.kind, tostring(entry.id), tostring(entry.icon), entry.key or "" }, ":")
        end
    end
    return table.concat(parts, ",")
end

-- Writes the export into WowDeckDB (saved to disk by the game on /reload or logout).
local function export()
    local name, realm = UnitFullName("player")
    if not name then
        return nil
    end
    local character = name .. "-" .. ((realm and realm ~= "") and realm or GetRealmName())
    local slots = {}
    for slot = 1, MAX_SLOT do
        slots[slot] = describeSlot(slot)
    end
    WowDeckDB = WowDeckDB or {}
    WowDeckDB.version = EXPORT_VERSION
    WowDeckDB.characters = WowDeckDB.characters or {}
    WowDeckDB.characters[character] = {
        updated = time(),
        class = select(2, UnitClass("player")),
        bars = barList,
        slots = slots,
    }
    WowDeckDB.lastCharacter = character
    return exportSignature(slots)
end

local function isStale()
    return savedSignature ~= nil and export() ~= savedSignature
end

local lastHint = 0
local function hintIfStale()
    if isStale() and GetTime() - lastHint > 60 and not InCombatLockdown() then
        lastHint = GetTime()
        print("|cff4fc3f7WowDeck|r: action bars changed. Type /reload to update your deck.")
    end
end

-- Bar and binding events arrive in bursts (login, dragging spells, keybinding UI); coalesce them.
local scheduled = false
local function scheduleSync()
    if scheduled then
        return
    end
    scheduled = true
    C_Timer.After(0.5, function()
        scheduled = false
        mapBars()
        if bindingSignature() ~= appliedSignature then
            applyDeckBindings() -- our own override bindings don't change this signature, so no loop
        end
        hintIfStale()
    end)
end

owner:RegisterEvent("PLAYER_LOGIN")
owner:RegisterEvent("PLAYER_LOGOUT")
owner:RegisterEvent("ACTIONBAR_SLOT_CHANGED")
owner:RegisterEvent("UPDATE_BINDINGS")
owner:RegisterEvent("PLAYER_REGEN_ENABLED")
owner:SetScript("OnEvent", function(_, event)
    if event == "PLAYER_LOGIN" then
        mapBars()
        applyDeckBindings()
        -- Bars finish loading shortly after login; take the baseline once they settle.
        C_Timer.After(3, function()
            mapBars()
            if bindingSignature() ~= appliedSignature then
                applyDeckBindings()
            end
            savedSignature = export()
        end)
    elseif event == "PLAYER_LOGOUT" then
        export() -- written to disk right after this event
    elseif event == "PLAYER_REGEN_ENABLED" then
        if pendingApply then
            scheduleSync()
        end
    else
        scheduleSync()
    end
end)

SLASH_WOWDECK1 = "/wowdeck"
SlashCmdList.WOWDECK = function()
    mapBars()
    if bindingSignature() ~= appliedSignature then
        applyDeckBindings()
    end
    local stale = isStale()
    local character = WowDeckDB and WowDeckDB.characters and WowDeckDB.characters[WowDeckDB.lastCharacter]
    local bound, deck = 0, 0
    for _, entry in pairs(character and character.slots or {}) do
        if entry.keySource == "binding" then
            bound = bound + 1
        elseif entry.keySource == "deck" then
            deck = deck + 1
        end
    end
    print(("|cff4fc3f7WowDeck|r: %d slots (%d on your keybinds, %d on deck chords). %s"):format(
        bound + deck, bound, deck, stale and "Type /reload to save changes for the deck." or "Deck is up to date."))
    local bars = {}
    for _, bar in ipairs(barList) do
        bars[#bars + 1] = ("%s %d-%d"):format(bar.name, bar.first, bar.first + 11)
    end
    print("|cff4fc3f7WowDeck|r bars: " .. table.concat(bars, ", "))
end
