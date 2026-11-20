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

---------------------------------------------------------------------------------------------
-- Profiling: /wowdeck perf shows how much time and memory each part of the addon uses.
-- Times include nested calls (sync includes export, and so on).
---------------------------------------------------------------------------------------------
local perfStats, perfEvents = {}, {}
local perfPaints = 0 -- beacon blocks recolored
local perfErrors, perfLastError = 0, nil -- errors caught while refreshing slots
local perfSince = GetTime()

local function perfRecord(name, start, memory)
    local elapsed = debugprofilestop() - start
    local allocated = collectgarbage("count") - memory
    local stat = perfStats[name]
    if not stat then
        stat = { calls = 0, total = 0, max = 0, kb = 0 }
        perfStats[name] = stat
    end
    stat.calls = stat.calls + 1
    stat.total = stat.total + elapsed
    if elapsed > stat.max then
        stat.max = elapsed
    end
    if allocated > 0 then -- negative when a garbage collection step ran meanwhile
        stat.kb = stat.kb + allocated
    end
end

-- Wraps a function so every call is timed under `name`.
local function profiled(name, fn)
    return function(...)
        local start, memory = debugprofilestop(), collectgarbage("count")
        local a, b = fn(...)
        perfRecord(name, start, memory)
        return a, b
    end
end

local function perfReport()
    local seconds = math.max(1, GetTime() - perfSince)
    print(("|cff4fc3f7WowDeck|r perf over %ds (ms/s = CPU milliseconds per second; 10 ms/s = 1%% of a core):"):format(seconds))
    local names = {}
    for name in pairs(perfStats) do
        names[#names + 1] = name
    end
    table.sort(names, function(a, b) return perfStats[a].total > perfStats[b].total end)
    for _, name in ipairs(names) do
        local s = perfStats[name]
        print(("  %-15s %6.1f calls/s  avg %.3f ms  max %.2f ms  %6.2f ms/s  %7.1f KB/s"):format(
            name, s.calls / seconds, s.total / s.calls, s.max, s.total / seconds, s.kb / seconds))
    end
    local events = {}
    for event, count in pairs(perfEvents) do
        events[#events + 1] = ("%s %.1f/s"):format(event, count / seconds)
    end
    table.sort(events)
    print("  events: " .. (#events > 0 and table.concat(events, ", ") or "none"))
    if UpdateAddOnMemoryUsage and GetAddOnMemoryUsage then
        UpdateAddOnMemoryUsage()
        print(("  memory: %.0f KB, beacon repaints %.1f/s"):format(GetAddOnMemoryUsage("WowDeck"), perfPaints / seconds))
    end
    local secrets = {}
    for name, count in pairs(perfSecrets) do
        secrets[#secrets + 1] = ("%s %d"):format(name, count)
    end
    table.sort(secrets)
    print("  secret (unreadable in combat): " .. (#secrets > 0 and table.concat(secrets, ", ") or "none"))
    if perfErrors > 0 then
        print(("  beacon errors: %d, last: %s"):format(perfErrors, tostring(perfLastError)))
    end
end

-- Newer clients hide some values from addons during combat ("secret values"): they can be passed
-- to the game's widgets but not compared or calculated with, which raises an error.
local isSecretValue = issecretvalue or function() return false end
local perfSecrets = {} -- kind of value -> times it was secret

-- True when any of the values is secret (counted under `name` for /wowdeck perf).
local function secret(name, a, b, c)
    if isSecretValue(a) or isSecretValue(b) or isSecretValue(c) then
        perfSecrets[name] = (perfSecrets[name] or 0) + 1
        return true
    end
    return false
end

local function perfReset()
    perfSecrets = {}
    perfStats, perfEvents, perfPaints = {}, {}, 0
    perfSince = GetTime()
end

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
mapBars = profiled("mapBars", mapBars)

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
local savedIdentities = nil -- slot -> action and key as of login, i.e. what the plugin can currently see
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
bindingSignature = profiled("bindingSig", bindingSignature)

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
applyDeckBindings = profiled("applyBindings", applyDeckBindings)

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

-- What the player arranged: which action sits on each slot and its key. Leaves out what the game
-- changes by itself, such as icons and the spell a macro currently shows, which follow form,
-- target and modifiers; including those made every form change look like an edited bar.
-- Spells are compared by their base spell: forms and talents swap in override spells with other
-- IDs (e.g. 414924 <-> 1238122) on the same slot.
local function slotIdentities(slots)
    local identities = {}
    for slot = 1, MAX_SLOT do
        local entry = slots[slot]
        if entry then
            local identity = entry.id
            if entry.kind == "macro" then
                identity = entry.macroIndex or entry.name
            elseif entry.kind == "spell" and entry.id and FindBaseSpellByID then
                identity = FindBaseSpellByID(entry.id) or entry.id
            end
            identities[slot] = ("%s %s [%s]"):format(entry.kind, tostring(identity), entry.key or "")
        end
    end
    return identities
end

-- Writes the export into WowDeckDB (saved to disk by the game on /reload or logout).
local function export()
    local name, realm = UnitFullName("player")
    if not name then
        return nil
    end
    local character = name .. "-" .. ((realm and realm ~= "") and realm or GetRealmName())
    local slots = {}
    local found = false
    for slot = 1, MAX_SLOT do
        slots[slot] = describeSlot(slot)
        found = found or slots[slot] ~= nil
    end
    WowDeckDB = WowDeckDB or {}
    WowDeckDB.version = EXPORT_VERSION
    WowDeckDB.characters = WowDeckDB.characters or {}
    -- While logging out or quitting, the game has already cleared the action bars, so they read
    -- as empty. Never let that wipe the last good export.
    local previous = WowDeckDB.characters[character]
    if not found and previous and previous.slots and next(previous.slots) then
        WowDeckDB.lastCharacter = character
        return previous.slots
    end
    WowDeckDB.characters[character] = {
        updated = time(),
        class = select(2, UnitClass("player")),
        bars = barList,
        slots = slots,
    }
    WowDeckDB.lastCharacter = character
    return slots
end
export = profiled("export", export)

-- Slots whose action or key differs from what the plugin saw at login: { slot, before, after }.
local function changedSlots()
    local changes = {}
    if not savedIdentities then
        return changes
    end
    local slots = export()
    local current = slots and slotIdentities(slots) or {}
    for slot = 1, MAX_SLOT do
        if current[slot] ~= savedIdentities[slot] then
            changes[#changes + 1] = { slot = slot, before = savedIdentities[slot], after = current[slot] }
        end
    end
    return changes
end

local function isStale()
    return #changedSlots() > 0
end

local lastHint = 0
local function hintIfStale()
    -- Cheap checks first: isStale() rebuilds the whole export.
    if GetTime() - lastHint > 60 and not InCombatLockdown() and isStale() then
        lastHint = GetTime()
        print("|cff4fc3f7WowDeck|r: action bars changed (/wowdeck changes shows which). Type /reload to update your deck.")
    end
end

-- Bar and binding events arrive in bursts (login, dragging spells, keybinding UI); coalesce them.
local scheduled = false
local function scheduleSync()
    if scheduled then
        return
    end
    scheduled = true
    C_Timer.After(0.5, profiled("sync", function()
        scheduled = false
        mapBars()
        if bindingSignature() ~= appliedSignature then
            applyDeckBindings() -- our own override bindings don't change this signature, so no loop
        end
        hintIfStale()
    end))
end

owner:RegisterEvent("PLAYER_LOGIN")
owner:RegisterEvent("PLAYER_LOGOUT")
owner:RegisterEvent("ACTIONBAR_SLOT_CHANGED")
owner:RegisterEvent("UPDATE_BINDINGS")
owner:RegisterEvent("PLAYER_REGEN_ENABLED")

---------------------------------------------------------------------------------------------
-- Pixel beacon: live slot state for the plugin, drawn as colored blocks at the top-left of
-- the screen. Mirrors src/live/beacon-codec.ts in the plugin; keep the two in sync.
-- The game may change colors on the way to the screen (HDR, gamma), so the beacon calibrates:
--   block 0: magenta, block 1: green (start marker, found by contrast)
--   block 2: header (version, frame counter, checksum)
--   blocks 3-10: calibration, level n (0-7) in all three channels
--   blocks 11 + 3(s-1) .. +2 for slot s: remaining, flags, count; each 8-bit value split into
--     digits of 3, 3 and 2 bits across one block's R, G and B
-- Level n is drawn as 8 + 16n (8-120), low enough to survive a ~2x brightening without clipping.
---------------------------------------------------------------------------------------------
local BEACON_BLOCK = 3
local BEACON_COLUMNS = 64
local BEACON_VERSION = 2
local BEACON_INTERVAL = 0.1
local BEACON_FIRST_SLOT_BLOCK = 11
local FLAG_PRESENT, FLAG_USABLE, FLAG_NO_MANA, FLAG_OUT_OF_RANGE = 1, 2, 4, 8
local FLAG_GLOW, FLAG_GLOBAL_COOLDOWN, FLAG_ACTIVE = 16, 32, 64

local beacon
local beaconBlocks = {}
local beaconCounter = 0

local SAFETY_REFRESH = 2 -- seconds between full refreshes, in case an event was missed
-- Cooldowns are left out of most of those: GetActionCooldown builds a ~520-byte table per call
-- on this client (see /wowdeck alloc), and the cooldown events are reliable.
local SAFETY_COOLDOWN_REFRESH = 10
local RANGE_EVERY = 2 -- range changes as the player moves, so it's polled: every 2nd update
local USABLE_GAP = 0.5 -- seconds; SPELL_UPDATE_USABLE fires on every mana/energy tick, so its re-reads are capped

-- Slot state is cached and refreshed by part when game events say that part changed, so an
-- update normally costs a few range checks plus arithmetic, instead of ~12 API calls per slot.
local slotCache = {} -- slot -> { kind, id, stackable, cdStart, cdDuration, usable, noMana, ... }
local occupied = {} -- occupied slots, in order
local dirty = { static = true, cooldown = true, usable = true, state = true, count = true, range = true }
-- Every part, for reading one slot afresh.
local ALL_PARTS = { cooldown = true, usable = true, state = true, count = true }
-- Slots named by ACTIONBAR_SLOT_CHANGED: just those are re-read, instead of the whole bar set.
local changedActions = {}
local usableSoon = false -- a throttled usable re-read is waiting (see USABLE_GAP)
local lastUsableRead = 0
local lastFullRefresh = 0
local lastCooldownRefresh = 0
local beaconTick = 0
local drawnValues, drawnSums = {}, {} -- slot -> packed value and digit sum currently on screen
local drawnTotal = 0 -- sum of drawnSums, for the checksum
local pending = {} -- slots to redraw on the next update
local cooling = {} -- slots with a cooldown counting down; redrawn every update

-- Which part of the cached slot state each game event makes out of date. Events this client
-- doesn't know are skipped; the periodic full refresh covers anything missed.
local BEACON_EVENTS = {
    ACTIONBAR_SLOT_CHANGED = "static",
    ACTIONBAR_UPDATE_COOLDOWN = "cooldown",
    SPELL_UPDATE_COOLDOWN = "cooldown",
    ACTIONBAR_UPDATE_USABLE = "usable", -- includes mana changes, as Blizzard's own buttons rely on
    SPELL_UPDATE_USABLE = "usableSoon", -- throttled: fires on every resource tick
    PLAYER_TARGET_CHANGED = "usable", -- also re-checks range; see the OnEvent handler
    UPDATE_SHAPESHIFT_FORM = "usable", -- forms change what can be cast
    ACTIONBAR_UPDATE_STATE = "state",
    START_AUTOREPEAT_SPELL = "state",
    STOP_AUTOREPEAT_SPELL = "state",
    SPELL_ACTIVATION_OVERLAY_GLOW_SHOW = "state",
    SPELL_ACTIVATION_OVERLAY_GLOW_HIDE = "state",
    BAG_UPDATE = "count",
    SPELL_UPDATE_CHARGES = "count",
}

local function actionCooldown(slot)
    -- The global version returns plain values; the C_ActionBar one builds a table every call.
    if GetActionCooldown then
        return GetActionCooldown(slot)
    end
    local info = C_ActionBar and C_ActionBar.GetActionCooldown and C_ActionBar.GetActionCooldown(slot)
    if type(info) == "table" then
        return info.startTime, info.duration, info.isEnabled
    end
end

-- Whole seconds (rounded up) below 200, then 200 + minutes (rounded up).
local function encodeRemaining(seconds)
    if seconds <= 0 then
        return 0
    end
    local whole = math.ceil(seconds)
    if whole < 200 then
        return whole
    end
    return math.min(255, 200 + math.ceil(seconds / 60))
end

-- Reads what is on one slot into the cache (reusing its entry). Returns whether the slot holds
-- an action, and whether that action is new or different (so its state needs reading).
local function readStatic(slot)
    local has = HasAction(slot)
    if secret("static", has) then
        return slotCache[slot] ~= nil, false -- unknown in combat: keep what we had
    elseif has then
        local cached = slotCache[slot]
        local changed = not cached
        cached = cached or { cdStart = 0, cdDuration = 0, count = 0 }
        local kind, id = GetActionInfo(slot)
        local consumable, stackable = IsConsumableAction(slot), IsStackableAction(slot)
        if not secret("static", kind, id) then
            changed = changed or cached.kind ~= kind or cached.id ~= id
            cached.kind, cached.id = kind, id
        end
        if not secret("static", consumable, stackable) then
            cached.stackable = consumable or stackable
        end
        slotCache[slot] = cached
        return true, changed
    elseif slotCache[slot] then
        slotCache[slot] = nil
        cooling[slot] = nil
        pending[slot] = true -- emptied: draw zeros
        return false, true
    end
    return false, false
end

-- Lists the occupied slots, in order, from the cache.
local function listOccupied()
    occupied = {}
    for slot = 1, MAX_SLOT do
        if slotCache[slot] then
            occupied[#occupied + 1] = slot
        end
    end
end

-- Re-reads what is on every slot; slots whose action changed are queued for a full read.
local function refreshOccupied()
    for slot = 1, MAX_SLOT do
        local has, changed = readStatic(slot)
        if has and changed then
            changedActions[slot] = true
        end
    end
    listOccupied()
end

-- Refreshes the dirty parts of one slot's cached state. A part whose values the game keeps
-- secret (in combat) keeps its last readable state.
local function refreshSlot(slot, cached, range, parts)
    if parts.cooldown then
        local start, duration, enabled = actionCooldown(slot)
        if not secret("cooldown", start, duration, enabled) then
            local on = (enabled == 1 or enabled == true) and start and start > 0 and duration and duration > 0
            cached.cdStart, cached.cdDuration = on and start or 0, on and duration or 0
        end
    end
    if parts.usable then
        local usable, noMana = IsUsableAction(slot)
        if not secret("usable", usable, noMana) then
            cached.usable, cached.noMana = usable, noMana
        end
    end
    if parts.state then
        local glow = cached.kind == "spell" and IsSpellOverlayed and IsSpellOverlayed(cached.id) or false
        local current, repeating = IsCurrentAction(slot), IsAutoRepeatAction(slot)
        if not secret("state", glow, current, repeating) then
            cached.glow, cached.active = glow, current or repeating
        end
    end
    if parts.count and cached.stackable then
        local count = GetActionCount(slot)
        if not secret("count", count) then
            cached.count = math.min(255, math.max(0, count or 0))
        end
    end
    if range then
        local inRange = IsActionInRange(slot)
        if not secret("range", inRange) then
            cached.outOfRange = inRange == false or inRange == 0
            cached.noRange = inRange == nil and UnitExists("target")
        end
    end
    pending[slot] = true
    if cached.cdStart > 0 then
        cooling[slot] = true
    end
end

-- Remaining (wire value) and flags for a cached slot; the cooldown is worked out from its start.
local function encodeSlot(cached, now)
    local flags = FLAG_PRESENT
    local remaining = 0
    if cached.cdStart > 0 then
        local left = cached.cdStart + cached.cdDuration - now
        if left <= 0 then
            cached.cdStart = 0 -- ended; stops the per-update redraw
        else
            if cached.cdDuration <= 1.5 then
                flags = flags + FLAG_GLOBAL_COOLDOWN -- shown by the game as a short sweep; not a real cooldown
            else
                remaining = encodeRemaining(left)
            end
        end
    end
    if cached.usable then flags = flags + FLAG_USABLE end
    if cached.noMana then flags = flags + FLAG_NO_MANA end
    if cached.outOfRange then flags = flags + FLAG_OUT_OF_RANGE end
    if cached.glow then flags = flags + FLAG_GLOW end
    if cached.active then flags = flags + FLAG_ACTIVE end
    return remaining, flags
end

-- Sets a block's color from channel values 0-255.
local function setBlock(index, r, g, b)
    local block = beaconBlocks[index]
    if block.r ~= r or block.g ~= g or block.b ~= b then
        block.r, block.g, block.b = r, g, b
        -- Tinting a white texture: SetColorTexture would replace the texture itself, which
        -- costs far more per call.
        local start, memory = debugprofilestop(), collectgarbage("count")
        block.texture:SetVertexColor(r / 255, g / 255, b / 255, 1)
        perfRecord("beacon.paint", start, memory)
        perfPaints = perfPaints + 1
    end
end

local function level(n)
    return 8 + 16 * n
end

-- Draws an 8-bit value as level digits of 3, 3 and 2 bits; returns the digit sum.
local function setValueBlock(index, value)
    local a, b, c = math.floor(value / 32), math.floor(value / 4) % 8, value % 4
    setBlock(index, level(a), level(b), level(c))
    return a + b + c
end

local function updateBeacon()
    beaconCounter = (beaconCounter + 1) % 8
    local now = GetTime()
    if now - lastFullRefresh >= SAFETY_REFRESH then
        lastFullRefresh = now
        for part in pairs(dirty) do
            if part ~= "cooldown" then
                dirty[part] = true
            end
        end
    end
    if now - lastCooldownRefresh >= SAFETY_COOLDOWN_REFRESH then
        lastCooldownRefresh = now
        dirty.cooldown = true
    end
    if dirty.static then
        refreshOccupied() -- queues new or changed slots in changedActions
    end
    if next(changedActions) then
        local start, memory = debugprofilestop(), collectgarbage("count")
        local moved = false
        for slot in pairs(changedActions) do
            changedActions[slot] = nil
            local had = slotCache[slot] ~= nil
            local has = readStatic(slot)
            moved = moved or had ~= has
            pending[slot] = true
            if has then
                local ok, problem = pcall(refreshSlot, slot, slotCache[slot], true, ALL_PARTS)
                if not ok then
                    perfErrors, perfLastError = perfErrors + 1, problem
                end
            end
        end
        if moved then
            listOccupied()
        end
        perfRecord("beacon.slot", start, memory)
    end
    beaconTick = beaconTick + 1
    if usableSoon and now - lastUsableRead >= USABLE_GAP then
        dirty.usable = true
    end
    if dirty.usable then
        usableSoon, lastUsableRead = false, now
    end
    if dirty.cooldown or dirty.usable or dirty.state or dirty.count then
        local start, memory = debugprofilestop(), collectgarbage("count")
        for i = 1, #occupied do
            local slot = occupied[i]
            -- Protected, so one unreadable value can't stop the whole update (which would freeze
            -- the beacon and drop the deck's live state).
            local ok, problem = pcall(refreshSlot, slot, slotCache[slot], false, dirty)
            if not ok then
                perfErrors, perfLastError = perfErrors + 1, problem
                pending[slot] = true
            end
        end
        perfRecord("beacon.read", start, memory)
    end
    -- Without a target every action reports "no range", so polling is skipped; the target
    -- change itself (dirty.range) does one pass that clears any out-of-range flags.
    -- Actions with no range for the current target (buffs, forms, mounts) report nil; they're
    -- remembered as noRange and skipped by the poll. A full pass (target change, and the 2 s
    -- safety refresh) checks every slot again.
    local hasTarget = UnitExists("target")
    if dirty.range or (beaconTick % RANGE_EVERY == 0 and hasTarget) then
        local start, memory = debugprofilestop(), collectgarbage("count")
        local full = dirty.range
        for i = 1, #occupied do
            local slot = occupied[i]
            local cached = slotCache[slot]
            if full or not cached.noRange then
                local inRange = IsActionInRange(slot)
                local outOfRange = cached.outOfRange
                if not secret("range", inRange) then
                    outOfRange = inRange == false or inRange == 0
                    cached.noRange = hasTarget and inRange == nil
                end
                if cached.outOfRange ~= outOfRange then
                    cached.outOfRange = outOfRange
                    pending[slot] = true
                end
            end
        end
        perfRecord("beacon.range", start, memory)
    end
    for part in pairs(dirty) do
        dirty[part] = false
    end

    -- Draw only slots that may have changed: ones just re-read or whose range flipped, plus ones
    -- with a cooldown counting down. The checksum uses a running total of the drawn digits.
    local start, memory = debugprofilestop(), collectgarbage("count")
    for slot in pairs(cooling) do
        pending[slot] = true
    end
    for slot in pairs(pending) do
        pending[slot] = nil -- clearing fields while traversing is allowed in Lua
        local cached = slotCache[slot]
        local remaining, flags, count = 0, 0, 0
        if cached then
            remaining, flags = encodeSlot(cached, now)
            count = cached.count
            if cached.cdStart == 0 then
                cooling[slot] = nil
            end
        end
        local packed = remaining * 65536 + flags * 256 + count
        if drawnValues[slot] ~= packed then
            drawnValues[slot] = packed
            local base = BEACON_FIRST_SLOT_BLOCK + (slot - 1) * 3
            local digits = setValueBlock(base, remaining) + setValueBlock(base + 1, flags) + setValueBlock(base + 2, count)
            drawnTotal = drawnTotal + digits - (drawnSums[slot] or 0)
            drawnSums[slot] = digits
        end
    end
    setBlock(2, level(BEACON_VERSION), level(beaconCounter), level((beaconCounter + drawnTotal) % 8))
    perfRecord("beacon.draw", start, memory)
end
updateBeacon = profiled("beacon", updateBeacon)

-- One UI unit = one physical pixel, whatever the UI scale, so every block is exactly 3x3 pixels.
local function scaleBeacon()
    local _, height = GetPhysicalScreenSize()
    if beacon and height and height > 0 then
        beacon:SetScale(768 / height)
    end
end

local function createBeacon()
    if beacon then
        return
    end
    -- No parent: not affected by UI scale, and not hidden by Alt+Z (which hides UIParent).
    beacon = CreateFrame("Frame", "WowDeckBeacon", nil)
    beacon:SetFrameStrata("TOOLTIP")
    beacon:SetFrameLevel(9000)
    beacon:EnableMouse(false)
    local blocks = BEACON_FIRST_SLOT_BLOCK + MAX_SLOT * 3
    local rows = math.ceil(blocks / BEACON_COLUMNS)
    beacon:SetSize(BEACON_COLUMNS * BEACON_BLOCK, rows * BEACON_BLOCK)
    beacon:SetPoint("TOPLEFT", WorldFrame, "TOPLEFT", 0, 0)
    for index = 0, blocks - 1 do
        local texture = beacon:CreateTexture(nil, "OVERLAY")
        texture:SetColorTexture(1, 1, 1, 1) -- white, recolored with SetVertexColor
        texture:SetSize(BEACON_BLOCK, BEACON_BLOCK)
        texture:SetPoint("TOPLEFT", beacon, "TOPLEFT",
            (index % BEACON_COLUMNS) * BEACON_BLOCK, -math.floor(index / BEACON_COLUMNS) * BEACON_BLOCK)
        if texture.SetSnapToPixelGrid then
            texture:SetSnapToPixelGrid(false)
            texture:SetTexelSnappingBias(0)
        end
        beaconBlocks[index] = { texture = texture }
    end
    setBlock(0, 255, 0, 255) -- start marker: magenta, then green
    setBlock(1, 0, 255, 0)
    for n = 0, 7 do
        setBlock(3 + n, level(n), level(n), level(n)) -- calibration
    end
    for slot = 1, MAX_SLOT do
        pending[slot] = true -- new textures aren't zero yet; the first update draws every slot
    end
    scaleBeacon()
    for event in pairs(BEACON_EVENTS) do
        pcall(beacon.RegisterEvent, beacon, event) -- unknown events raise errors on some clients
    end
    beacon:SetScript("OnEvent", function(_, event, slot)
        if event ~= "ACTIONBAR_SLOT_CHANGED" then -- already counted by the main handler
            perfEvents[event] = (perfEvents[event] or 0) + 1
        end
        local part = BEACON_EVENTS[event]
        if event == "ACTIONBAR_SLOT_CHANGED" and not isSecretValue(slot)
            and type(slot) == "number" and slot >= 1 and slot <= MAX_SLOT then
            changedActions[slot] = true -- just this slot; anything else re-reads every slot
        elseif part == "usableSoon" then
            usableSoon = true
        else
            dirty[part] = true
        end
        if event == "PLAYER_TARGET_CHANGED" then
            dirty.range = true
        end
    end)
    -- While hidden, OnUpdate doesn't run; read everything afresh when shown again.
    beacon:SetScript("OnShow", function()
        lastFullRefresh, lastCooldownRefresh = 0, 0
    end)
    local elapsed = 0
    beacon:SetScript("OnUpdate", function(_, delta)
        elapsed = elapsed + delta
        if elapsed >= BEACON_INTERVAL then
            elapsed = 0
            updateBeacon()
        end
    end)
    updateBeacon()
end

local function setBeaconEnabled(enabled)
    WowDeckDB = WowDeckDB or {}
    WowDeckDB.beacon = enabled
    if enabled then
        createBeacon()
        beacon:Show()
    elseif beacon then
        beacon:Hide()
    end
end

owner:RegisterEvent("DISPLAY_SIZE_CHANGED")
owner:RegisterEvent("UI_SCALE_CHANGED")

owner:SetScript("OnEvent", function(_, event)
    perfEvents[event] = (perfEvents[event] or 0) + 1
    if event == "DISPLAY_SIZE_CHANGED" or event == "UI_SCALE_CHANGED" then
        scaleBeacon()
        return
    end
    if event == "PLAYER_LOGIN" then
        -- The beacon is on unless turned off with /wowdeck beacon.
        setBeaconEnabled(not (WowDeckDB and WowDeckDB.beacon == false))
        mapBars()
        applyDeckBindings()
        -- Bars finish loading shortly after login; take the baseline once they settle.
        C_Timer.After(3, function()
            mapBars()
            if bindingSignature() ~= appliedSignature then
                applyDeckBindings()
            end
            savedIdentities = slotIdentities(export() or {})
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
SlashCmdList.WOWDECK = function(message)
    local command = message and message:lower():match("^%s*(.-)%s*$") or ""
    if command == "perf" then
        perfReport()
        return
    elseif command == "perf reset" then
        perfReset()
        print("|cff4fc3f7WowDeck|r: perf counters reset.")
        return
    elseif command == "alloc" then
        -- Which action APIs allocate memory on this client: each runs over every slot 20 times.
        local function spellOf(slot)
            local kind, id = GetActionInfo(slot)
            if kind == "spell" and not isSecretValue(id) then
                return id
            end
        end
        local function onSpell(fn)
            return fn and function(slot)
                local id = spellOf(slot)
                if id then
                    fn(id)
                end
            end
        end
        local barCooldown = C_ActionBar and C_ActionBar.GetActionCooldown
        local spellCooldown = C_Spell and C_Spell.GetSpellCooldown
        local probes = {
            { "HasAction", HasAction }, { "GetActionInfo", GetActionInfo },
            { "C_ActionBar.GetActionCooldown", barCooldown },
            { "GetSpellCooldown (spells)", onSpell(GetSpellCooldown) },
            { "C_Spell.GetSpellCooldown (spells)", onSpell(spellCooldown) },
            { "  just GetActionInfo (baseline)", onSpell(function() end) },
            { "GetActionCooldown", GetActionCooldown }, { "IsUsableAction", IsUsableAction },
            { "IsActionInRange", IsActionInRange }, { "IsCurrentAction", IsCurrentAction },
            { "IsAutoRepeatAction", IsAutoRepeatAction }, { "GetActionCount", GetActionCount },
        }
        print(("|cff4fc3f7WowDeck|r: API cost over %d calls each:"):format(MAX_SLOT * 20))
        for _, probe in ipairs(probes) do
            local name, fn = probe[1], probe[2]
            if fn then
                collectgarbage("stop")
                local start, memory = debugprofilestop(), collectgarbage("count")
                for _ = 1, 20 do
                    for slot = 1, MAX_SLOT do
                        fn(slot)
                    end
                end
                local ms, kb = debugprofilestop() - start, collectgarbage("count") - memory
                collectgarbage("restart")
                print(("  %-34s %7.3f ms  %8.1f KB  (%d bytes/call)"):format(
                    name, ms, kb, math.floor(kb * 1024 / (MAX_SLOT * 20) + 0.5)))
            else
                print(("  %-34s missing"):format(name))
            end
        end
        return
    elseif command == "changes" then
        local changes = changedSlots()
        print(("|cff4fc3f7WowDeck|r: %d slot(s) differ from what the deck has:"):format(#changes))
        for i = 1, math.min(#changes, 15) do
            local change = changes[i]
            print(("  slot %d: %s -> %s"):format(change.slot, change.before or "empty", change.after or "empty"))
        end
        return
    end
    if message and message:lower():match("^%s*beacon") then
        local enabled = not (beacon and beacon:IsShown())
        setBeaconEnabled(enabled)
        print(("|cff4fc3f7WowDeck|r: live beacon %s."):format(enabled and "on (top-left corner)" or "off"))
        return
    end
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
    print(("|cff4fc3f7WowDeck|r: live beacon %s. Type /wowdeck beacon to toggle it."):format(
        (beacon and beacon:IsShown()) and "on" or "off"))
end
