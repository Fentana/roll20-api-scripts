var ShapedSpellbook = ShapedSpellbook || (function() {
    'use strict';

    var version = '0.4',
    
    checkInstall = function () {
        if (typeof LHU === 'undefined' || (LHU.version < 0.2)) {
            throw new Error ("ShapedSpellbook Error, incorrect version of LHU utilities script installed, please upgrade.");
        }
        LHU.ensureMixins();
        if (typeof ShapedSpellbookDefaults === 'undefined') {
            throw new Error ("ShapedSpellbook Error, spell defaults script not installed");
        }
        log("Loaded ShapedSpellbook v." + version);
    },
    
    HandleInput = function(msg) {
        try{
            if(msg.type !== 'api' || 
                msg.content.indexOf('!5esb') !== 0) {
                return;
            }
            var parameterMap = parseArguments(_.rest(msg.content.split('--')));
            switch(_.keys(parameterMap)[0]) {
                case 'long-rest':
                    _.each(getSelectedCharacters(msg), handleLongRest);
                    break;
                case 'show':
                    showSpellBook(_.first(getSelectedCharacters(msg)), msg.playerid);
                    break;
                case "cast":
                    attemptSpell(msg.playerid, getObj("character", parameterMap.character), 
                                parameterMap['cast'], parameterMap.level, parameterMap.targetId, 
                                resolveAC(parameterMap.targetAC, msg.inlinerolls),
                                _.has(parameterMap, 'ritual'));
                    break;
                case "test":
                    var string = "[[1d20cs>20 ]] [[1d20 + [[2 ]] ]]";
                    sendChat("",string);
                    break;
                default:
                    log('Unrecognised command');
                    log(msg);
            }
        }
        catch(e) {
            log('ERROR:')
            log(e.message);
            log(e.stack);
            log('*******');
            message("There was an error, see log for more details", msg.playerid);
        }
    },
    
    spellHandlers = {},
    
    registerCustomSpellHandler = function(spellName, handler) {
        if(!_.some(fifthSpells.spellsData, function(spell){ return spell['name'] === spellName;} )) {
            log('Warning, registering handler for spell "' + spellName + '" not found in standard spell list.');
        }
        else {
            log('Registering handler ' + handler + ' for spell "' + spellName + '".');
        }
        spellHandlers[spellName] = handler;  
    },
    
    //This is pure evil. Thanks to this: https://app.roll20.net/forum/post/2434679/floor-expressions-being-mangled-on-the-way-in-to-api
    //the only reliable way to get the AC of a target into this script is by putting a @{target|AC} parameter on the API call. Thanks
    //to brokenness in the way the attribute is processed, it turns up to us as a massive math expression, which sendChat refuses to evaluate
    //for some reason. As a workaround, I have turned it into javascript and called eval() on it. Urgh.
    resolveAC = function(acExpression, inlineRolls) {
        if (!acExpression) { return ""}
        var re = /\$\[\[([\d]+)\]\]/g;
        var re2 = /(abs|floor)/g;
        var resolved =  acExpression.replace(re, function(match, rollIndex) {
            return inlineRolls[rollIndex].results.total;
        }).replace(re2, 'Math.$1');
        return '[[0d0 + '+ eval(resolved) + ' ]]';
    },
    
    
    parseArguments = function(args) {
        return _.chain(args).map(function(argumentBlock) {
                        return argumentBlock.split(" ");
                    })
                    .reduce(function(parameterMap, parameterPieces) {
                        parameterMap[parameterPieces.shift()] = parameterPieces.join(" ").trim();
                        return parameterMap;
                     }, {})
                     .value();
    },
    
    attemptSpell = function(playerId, character, spellName, castingLevel, targetId, targetAC, ritual) {
        
        
        var spellMap = buildSpellMap(character);
        var spell = spellMap[spellName];
        if (_.isUndefined(spell)) {
            message(character.get('name') + " doesn't know the spell " + spellName, playerId);
            return;
        }
        //If no level is specified cast at the level of the spell
        castingLevel = castingLevel || spell.spellbaselevel;
        if (spell.spellbaselevel === 0) {
            castSpell(character, spell, 0, targetId, targetAC);
        }
        else if(ritual) {
            if (spell.spellritual != 0) {
                //Be explicit about level, not allowed to cast rituals at higher level
                castSpell(character, spell, spell.spellbaselevel, targetId, targetAC, true);
            }
            else {
                message(character.get('name') + " cannot cast " + spellName + " as a ritual", playerId);
                return;
            }
        }
        else if(spell['spellisprepared'] === "on") {
            awaitWarlockSlots(character, function(warlockSlots){
                if (getTotalSpellSlotsRemainingByLevel(character, warlockSlots)[castingLevel] > 0) {
                    if (castSpell(character, spell, castingLevel, targetId, targetAC)) {
                        decrementSpellSlots(character, castingLevel, playerId, warlockSlots);    
                    }
                }
                else {
                    message(character.get('name') + " doesn't have any slots of level " +castingLevel + ' left to cast ' + spellName + " Spellbook will reload. ", playerId);
                    showSpellBook(character, playerId);
                }
            });
        }
        else {
            message(character.get('name') + " doesn't have the spell " + spellName + " prepared.", playerId)
        }
    },
    
    castSpell = function(character, spell, castingLevel, targetId, targetAC, ritual) {
        var targetName ="";
        var targetCharacterId="";
        if (targetId) {
            var token = getObj("graphic", targetId);
            targetCharacterId = token.get("represents");
            targetName = token.get("name");
        }
        var outputFunc = _.partial(outputSpell, character, spell, castingLevel, targetCharacterId, targetName, targetAC, ritual)
        if (spellHandlers[spell.spellname]) {
            return spellHandlers[spell.spellname].handlerFunction(character, 
                                                            spell.spellname, 
                                                            castingLevel,
                                                            targetCharacterId,
                                                            targetName,
                                                            ritual, 
                                                            _.partial(sendChat, character.get('name')), 
                                                            outputFunc);
        }
        else {
            outputFunc();
            return true;
        }
       
    },

    
    outputSpell = function(character, spell, castingLevel, targetCharacterId, targetName, targetAC, ritual) {
        if(ritual){ 
            spell.spell_casting_time =  '10 mins';
        }
        else {
            spell.spellritual = '';
        }
       
        spell.casting_level = castingLevel;
        spell.friendly_level = (spell.spellbaselevel == 0) ? "Cantrip" : "Level " + spell.spellbaselevel;
        
    
        //We need to replace all attributes defined in the spell, then run substitution
        //against the hidden variable lookups pulled from the charsheet, and finally inject values
        // for target info We keep going round this loop until no more replacements happen
        var rollTemplate = interpolateAttributes(spellCastRollTemplate, 
                                                    [getMapLookup(spell),
                                                    getMapLookup({attacks_vs_target_ac: targetAC, 
                                                                    attacks_vs_target_name: targetName})
                                                     ]);
                                                     
                                                     
        //Do this last to avoid loads of crappy error messages in the log for 
        //attributes that come from elsewhere that it can't find. Also this
        //is probably slower than the rest and we should avoid doing it more than
        //needed.
        rollTemplate = interpolateAttributes(rollTemplate, [getCharacterAttributeLookup(character)]);
        rollTemplate = stripHelpfulLabelsToAvoidRoll20ApiBug(rollTemplate);
        rollTemplate = removeNestedRolls(rollTemplate);
        sendChat(character.get('name'), rollTemplate);
    },
    
    //OMG this is *so* deeply nasty. For some reason the API frequently barfs
    //on nested inline rolls, especially where there are two in a row. It outputs
    //the math expression without evaluation, for some bizarre reason. This
    //function collapse all the nested rolls so each roll is a single expression to avoid
    //this bug
    removeNestedRolls = function(rollTemplate) {
        var nestLevel = 0;
        var re = /(?:\[\[|\]\])/g;
        return rollTemplate.replace(re, function(match) {
            if (match === '[[') {
                return (++nestLevel > 1) ? "" : "[[";
            }
            else {
                return (--nestLevel > 0) ? "" : "]]";
            }
        });     
    },

    stripHelpfulLabelsToAvoidRoll20ApiBug = function(chatString) {
        return chatString.replace(/\[[ a-zA-Z_-]+\]/g, "");
    },

    interpolateAttributes = function(rollTemplate, lookupFunctions) {
        var replacementMade = false;
        var safetyCount = 0;
        var regexp = /\@\{([^\}]+)\}/gi;
        do {
            var startingRollTemplate = rollTemplate;
            rollTemplate = _.reduce(lookupFunctions, function(innerRollTemplate, lookupFunc, index){
                return innerRollTemplate.replace(regexp, function(match, submatch) {
                    var replacement = lookupFunc(submatch);
                    if (replacement != null) {
                        return replacement;
                    }
                    else {
                        return match;
                    }
                });
            }, rollTemplate);
            replacementMade = (rollTemplate != startingRollTemplate);
        } while (replacementMade && (++safetyCount  < 10) );
        return rollTemplate;
    },
    
    getCharacterAttributeLookup = function(character) {
        return function(key) {
            var value = getAttrByName(character.id, key);
            return _.isUndefined(value) ? null : value;
        }
    },
    
    getMapLookup = function(map) {
        return function(key) {
            return _.has(map, key) ? map[key] : null;
        }  
    },

    
    decrementSpellSlots = function(character, castingLevel, playerId, warlockSlots) {
        var otherSpellSlots = getNormalSpellSlots(character);
        //Try warlock slots first, as they are cheapest
        if (!_.isEmpty(warlockSlots) && warlockSlots[0].level == castingLevel && warlockSlots[0].current > 0) {
            warlockSlots[0].attribute.set('current', --warlockSlots[0].current);
            return;
        }
        
        if(otherSpellSlots[castingLevel].current > 0) {
            otherSpellSlots[castingLevel].attribute.set('current', --otherSpellSlots[castingLevel].current);
            return;
        }
        
        throw new Error('No slots of level ' + castingLevel + ' were available, spell could not be cast!');
    },
    
    showSpellBook = function(character, playerId) {
        if(!character) {
            message("ERROR: You must have a token selected to display the spell book!", playerId);
            return;
        }
        awaitWarlockSlots(character, function(warlockSlots){
            var remainingSlots = getTotalSpellSlotsRemainingByLevel(character, warlockSlots);
            var buttons = _.chain(buildSpellMap(character))
                .tap(function(spells) { if(_.isEmpty(spells)) { return; }})
                .sortBy(function(spell) {
                    return spell.spellbaselevel + '_' + spell.spellname;
                })
                .reduce(getSpellButtonAppender(character, remainingSlots), {})
                .value();
        
             message(buildUI(buttons, character, warlockSlots), playerId, true);
        });
    },
    
    buildUI = function(buttonMap, character, warlockSlots) {
        var ui = '<div style="border: 1px solid black; background-color: white; padding: 3px 3px;">';
        ui += '<h3>' + character.get('name') + "'s Spellbook</h3>";
        var slotMap = _.chain(getNormalSpellSlots(character))
            .concat(warlockSlots)
            .filter(function(slot) { return slot.max > 0; } )
            .reduce(function(map, slot) {
                (map[slot.level] = map[slot.level] || []).push(slot);
                return map;
            },{}).value();
            
        _.chain(slotMap)
            .keys()
            .difference(_.keys(buttonMap))
            .each(function(slotLevel) {
                buttonMap[slotLevel] = [];
            });        
        ui = _.chain(buttonMap)
            .reduce(function(uiString, buttonArray, level){
                uiString += "<h4> " + getLevelString(level, true);
                if (level !== '0') { 
                    _.each(slotMap[level], function(slot) {
                        uiString += "<span style='font-size:80%'> (" + slot.current + "/" + slot.max + " "
                        if(slot.isWarlock) uiString += " Wlk"
                        uiString += ")</span>"; 
                    });
                }
                uiString += "</h4>"
               
                uiString += "<div style='margin:2px; background-color: lightblue; padding 2px'>";
                uiString = _.reduce(buttonArray, function(uiString, button) {
                   uiString += button; 
                   return uiString;
                }, uiString);
                uiString += "</div>"
                return uiString;
            }, ui).value();
        ui += '</div>';
        return ui;
    },
    
    getLevelString = function(level, plural) {
        if (plural) {
            return level == 0 ? "Cantrips" : ("Level " + level + ' Spells');
        }
        return level === 0 ? "Cantrip" : ("Level " + level);
    },
    
    getSpellButtonAppender = function(character, remainingSlots) {
        return function(buttonMap, spell) {
            var enabled = false;    
            var spellButtons = [];
            if (spell.spellbaselevel === 0) {
                spellButtons.push(getSpellButtonText(spell, null, character, false));
            }
            else {
                var validSpellSlots = calculateValidSpellSlots(spell, remainingSlots);
                if(spell['spellisprepared'] === "on" && !_.isEmpty(validSpellSlots)) {
                    var appropriateSlots = getAppropriateSlots(spell, validSpellSlots);
                    spellButtons.push(getSpellButtonText(spell, appropriateSlots, character, false));
                }
                
                if (spell['spellritual'] != 0) {
                    spellButtons.push(getSpellButtonText(spell, appropriateSlots, character, true));
                }
            }
            
            if(_.isEmpty(spellButtons)) {
                spellButtons.push('<span style="color:gray; background-color:lightgrey; padding:5px; display:inline-block; border: 1px solid white;" >' + spell.spellname + '</span>');    
            }
            
            buttonMap[spell.spellbaselevel] = buttonMap[spell.spellbaselevel] ? buttonMap[spell.spellbaselevel].concat(spellButtons) : spellButtons;
            
            return buttonMap;
        };  
    }, 
    
    getSpellButtonText = function(spell, appropriateSlots, character, asRitual) {
        var targetParam = spellNeedsTarget(spell) ? " --targetId " + LHU.ch('@') + "{target|token_id} --targetAC " + LHU.ch('@') + "{target|AC}" : "";
        var ritualFlag = asRitual ? " --ritual " : "";
        var spellButtonText = spell.spellname + (asRitual ? " (R)" : "");
        var titleText = asRitual ? "" : ' title="Spell slots: ' + getLevelsButtonText(appropriateSlots) + '" ';
        var spellLevelParam = asRitual ? "" : buildSpellLevelParam(spell,appropriateSlots);
        return '<a href="!5esb --cast ' + spell.spellname + spellLevelParam + ' --character ' + character.id + targetParam + ritualFlag + '"' + titleText + '>' + spellButtonText + '</a>'
    },
    
    getLevelsButtonText = function(appropriateSlots) {
        if (appropriateSlots === null) {
            return "";
        }
        
        var slotMunger = {
            slotText: "",
            slotQueue: [],
            getReduceHandler: function() {
                return function(unusued, slot) {
                    return this.push(slot);    
                }.bind(this);
            },
            
            push: function(slot) {
                if (_.isEmpty(this.slotQueue) || _.last(this.slotQueue) === slot - 1) {
                    this.slotQueue.push(slot);
                }
                else {
                    this.appendQueueToText();
                    this.slotQueue.push(slot);
                }
                return this;
            },
            getSlotText: function() {
                this.appendQueueToText();
                return this.slotText;
            },
            appendQueueToText: function() {
                if (this.slotQueue.length) {
                    this.slotText += (this.slotText.length === 0) ? "" : ",";
                    this.slotText += (this.slotQueue.length > 2) ?
                        this.slotQueue[0] + "-" + _.last(this.slotQueue) :
                        this.slotQueue.join(",");
                    this.slotQueue = [];
                }
            }
        };
        
        return _.reduce(appropriateSlots, slotMunger.getReduceHandler(), slotMunger).getSlotText();
    },
    
    spellNeedsTarget = function(spell) {
        if (spellHandlers[spell.spellname] && spellHandlers[spell.spellname].requestTarget) {
            return true;
        }
        
        return (!_.isEmpty(spell.spell_toggle_save) || 
                    !_.isEmpty(spell.spell_toggle_attack)) && 
                _.isEmpty(spell.spellaoe);
    },
   
    spellCanBeCastHigher = function(spell) {
        return !_.isEmpty(spell['spellhighersloteffect']) || !_.isEmpty(spell['spell_toggle_higher_lvl_query']);
    },
    
    getAppropriateSlots = function(spell, validSlots) {
        //If it's not a spell that can be cast at a higher level 
        //for additional effects, then there's no reason to cast
        //at anything but the lowest level
        if(!_.isEmpty(validSlots) && !spellCanBeCastHigher(spell)) {
            return validSlots.slice(0,1);
        }
        else {
            return validSlots;
        }
    },
    
    buildSpellLevelParam = function(spell, slots) {
        if (slots === null) {
            return "";
        }
        var singleSlot =  _.size(slots) === 1;
        var paramString = " --level " + (singleSlot ? "" : "?{Slot level");
         return  _.chain(slots)
                        .reduce(function(paramString, slotLevel, slotIndex) {
                            paramString += (singleSlot ? "" : "|") + slotLevel;
                            return paramString;
                        }, paramString)
                        .value().concat(singleSlot ? "" : "}");
    },
   
    calculateValidSpellSlots = function(spell, remainingSlots) {
        return  _.chain(remainingSlots).map(function(spellsRemaining, slotLevel) {
                        return (slotLevel >= spell.spellbaselevel && spellsRemaining > 0) ? slotLevel : null; 
                    })
                .compact()
                .value();
    },
   
    getTotalSpellSlotsRemainingByLevel = function(character, warlockSlots) {
        var nonZeroFound = false;
        return _.chain(getNormalSpellSlots(character))
            .concat(warlockSlots)
            .reduce(function(slotArray, slotDetails) {
                slotArray[slotDetails['level']] += slotDetails['current'];
                return slotArray;
            }, initialiseEmptySpellSlotArray()).
            reduceRight(function(slotArray, spellsRemaining, index) {
                if(spellsRemaining > 0 || nonZeroFound) {
                    nonZeroFound = true;
                    slotArray[index] = spellsRemaining;  
                }
                return slotArray;
            }, []).value();  
    },
    
    initialiseEmptySpellSlotArray = function() {
        return _.range(0,10).map(_.constant(0));
    },
   
    getNormalSpellSlots = function(character) {
        return _.chain(_.range(1,10))
                        .map(function(level){
                            var attribute = findObjs({_type: 'attribute', _characterid: character.id, name: "spell_slots_l" + level})[0];
                            var current = parseInt(getAttrByName(character.id, 'spell_slots_l' + level, 'current'), 10) || 0;
                            var max  =  parseInt(getAttrByName(character.id, 'spell_slots_l' + level, 'max'), 10) || 0;
                            return {level:level, current:current, attribute:attribute, max:max};
                        })
                        .splice(0,0,{level:0, current:0, attribute:null})
                        .value();
    },
    
    getAttributeExpressionPromise = function(character, expression) {
        var name = character.get("name");
        expression = expression.replace(/@\{([^\}]+)\}/g, "@{" + name + "|$1}");
        var promise = {
            expression:expression,
            resolved:false,
            listeners:[],
            _result: undefined,
            getChatHandler:function(){
                return function(rollResult) {
                    this._result = rollResult[0].inlinerolls[0].results.total;
                    this.resolved = true;
                    _.each(this.listeners, function(listener) {
                        listener(this._result);
                    }.bind(this));
                }.bind(this);
            },
            result:function(callback) {
                if (promise.resolved) {
                    callback(this._result);
                }
                else {
                    promise.listeners.push(callback);
                }
            }
        };
        sendChat("", expression, promise.getChatHandler());
        
        return promise;
    },

    
    awaitWarlockSlots = function(character, callback) {
        var warlockSpellSlotsLevel = getAttributeExpressionPromise(character, "[[0d0 + " + getAttrByName(character.id, 'warlock_spell_slots_level', 'current') + "]]");
        var warlockSpellSlotsMax = getAttributeExpressionPromise(character, " [[0d0 + " + getAttrByName(character.id, 'warlock_spell_slots', 'max') +" ]]");
        var warlockSpellSlots = parseInt(getAttrByName(character.id, 'warlock_spell_slots', 'current'), 10) || 0;  
        var warlockSlotAttribute =  findObjs({_type: 'attribute', _characterid: character.id, name: 'warlock_spell_slots'})[0];
        var slots = {level:undefined, current:warlockSpellSlots, max:undefined, attribute:warlockSlotAttribute, isWarlock:true};
        warlockSpellSlotsMax.result(function(resolvedValue){
            slots.max = parseInt(resolvedValue, 10) || 0;   
        });
        warlockSpellSlotsLevel.result(function(resolvedValue){
            slots.level = parseInt(resolvedValue, 10) || 0;   
        });
        awaitAll([warlockSpellSlotsMax, warlockSpellSlotsLevel], function() {
            var pruned = pruneWarlockSlots([slots]);
            callback(pruned);
        });
    },
    
    
    awaitAll = function(promiseArray, callback) {
        var resolvedCount = 0;
        _.each(promiseArray, function(promise) {
            promise.result(function() {
                if (++resolvedCount == _.size(promiseArray)) {
                    callback();
                }
            });    
        });
    },
    
   
    pruneWarlockSlots = function(warlockSlots) {
        if(warlockSlots[0].level === 0) return [];
        return warlockSlots;
    },
      
    handleLongRest = function(character) {
        awaitWarlockSlots(character, function(warlockSlots) {           
            _.chain(getNormalSpellSlots(character))
                .concat(warlockSlots)
                .reject(function(slot) { return slot.level === 0 || slot.max === 0})
                .each(function(slot) {
                    slot.attribute.set('current', slot.max);
                });
        });
    },  
    
   
    
    buildSpellMap = function(character) {
      var re = /repeating_spellbook(?:(cantrip)|level([\d]))_([\d]+)_(.*)/;
      return _.chain(findObjs({_type: 'attribute', _characterid: character.id}))
        .select(function(attribute){
            return attribute.get('name').indexOf("repeating_spellbook") == 0;  
        })
        .map(function(attribute) {
            var results = re.exec(attribute.get('name'));
            var spellLevel = parseInt(results[2], 10) || 0;
            return {spellIndex: spellLevel + '_' + results[3], indexInLevel: results[3], fieldName: results[4], fieldValue: attribute.get('current'), level: spellLevel};
        })
        .groupBy('spellIndex')
        .reduce(function(spellMap, spellEntry){
            var spellObject = _.reduce(spellEntry, function(spell, fieldObject){
                spell[fieldObject.fieldName] = fieldObject.fieldValue;
                spell['spellbaselevel'] = fieldObject.level;
                spell['originalIndex'] = "repeating_spellbook" + ((fieldObject.level == 0) ? "cantrip" : fieldObject.level) + "_" + fieldObject.indexInLevel + "_";
                return spell;
            }, getBaseSpellObject());
            spellMap[spellObject.spellname] = spellObject;
            return spellMap;
        }, {})
        .value(); 
        
    },
    
    getBaseSpellObject = function() {
        var spell =   _.clone(ShapedSpellbookDefaults.values);
        spell.spell_var_output_higher_lvl_query = "{{spell_cast_as_level=Level @{casting_level}}}";
        spell.higher_level_query =  "@{casting_level}";
        return spell;
    },
    
    getSelectedCharacters = function(msg, callback) {
        return _.chain(getSelectedTokens(msg))
                    .map(LHU.getObjectMapperFunc(LHU.getPropertyResolver('represents'), 'character'))
                    .map(function(character) {
                        var spellDataHash = getAttrByName(character.id, "spell_data_hash");
                        if (!spellDataHash || spellDataHash !== ShapedSpellbookDefaults.hash) {
                            throw new Error('ShapedSpellbook ERROR: ' + character.get('name')  + " is using a character sheet that does not match the version of the spellbook script")
                        }
                        return character;
                    })
                    .value();
    },
    
    getSelectedTokens = function(msg) {
       return  _.chain([msg.selected]).flatten().compact()
            .tap(function(selectionList) {
                if(_.isEmpty(selectionList)) {
                    log('No token selected');
                }
            })
            .filter(_.matcher({_type: 'graphic'}))
            .map(LHU.getObjectMapperFunc(LHU.getPropertyResolver('_id'), 'graphic', 'token'))
            .value();
    },
    
    getPlayerName = function(playerId) {
        return getObj('player', playerId).get("_displayname");
    },
    
    message = function(text, playerId) {
        var playerName = getPlayerName(playerId);
        var sendingCommand = "/w ";
        sendChat("Spell Book", sendingCommand + '"' + playerName + '" ' + text);
        if(!playerIsGM(playerId)) {
            sendChat("Spell Book", sendingCommand + "gm " + text);
        }
    },
    
   
     
    spellCastRollTemplate = "@{output_option} &{template:5eDefault} {{spell=1}} {{character_name=@{character_name}}} " +
                            "@{show_character_name} {{spellfriendlylevel=@{friendly_level}}} {{title=@{spellname}}} " + 
                            "@{spellconcentration} @{spellritual} {{spellschool=@{spellschool}}} " +
                            "{{spell_casting_time=@{spell_casting_time}}} {{spellduration=@{spellduration}}} {{target=@{spelltarget}}} " +
                            "{{aoe=@{spellaoe}}} {{range=@{spellrange}}} @{spellcomponents_verbal} @{spellcomponents_somatic} " +
                            "@{spellcomponents_material} @{spell_toggle_description} @{spell_toggle_higher_lvl} @{spell_toggle_emote} " + 
                            "@{spell_toggle_attack} @{spell_toggle_attack_damage} @{spell_toggle_attack_second_damage} " +
                            "@{spell_toggle_attack_crit} @{spell_toggle_save} @{spell_toggle_save_damage} @{spell_toggle_bonuses} " +
                            "@{spell_toggle_healing} @{spell_toggle_effects} @{spell_toggle_source} @{spell_toggle_gained_from} " +
                            "@{spell_toggle_output_higher_lvl_query} @{classactionspellcast}",
   
  
   
    registerEventHandlers = function () {
        on('chat:message', HandleInput);
    };
    
    
    
    return { CheckInstall: checkInstall, RegisterEventHandlers: registerEventHandlers, RegisterCustomSpellHandler:registerCustomSpellHandler};
    
})();

on("ready",function(){
    'use strict';

        ShapedSpellbook.CheckInstall();
        ShapedSpellbook.RegisterEventHandlers();
});
