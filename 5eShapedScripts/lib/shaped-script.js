/* globals unescape */
'use strict';
var _ = require('underscore');
var srdConverter = require('./srd-converter');
var parseModule = require('./parser');
var cp = require('./command-parser');
var utils = require('./utils');
var mpp = require('./monster-post-processor');
var AdvantageTracker = require('./advantage-tracker');
var ConfigUI = require('./config-ui');

var version = '0.8.2',
  schemaVersion = 0.10,
  configDefaults = {
    logLevel: 'INFO',
    tokenSettings: {
      number: false,
      bar1: {
        attribute: 'HP',
        max: true,
        link: false,
        showPlayers: false
      },
      bar2: {
        attribute: 'speed',
        max: false,
        link: true,
        showPlayers: false
      },
      bar3: {
        attribute: '',
        max: false,
        link: false,
        showPlayers: false
      },
      aura1: {
        radius: '',
        color: '#FFFF99',
        square: false
      },
      aura2: {
        radius: '',
        color: '#59e594',
        square: false
      },
      light: {
        radius: '',
        dimRadius: '',
        otherPlayers: false,
        hasSight: false,
        angle: 360,
        losAngle: 360,
        multiplier: 1
      },
      showName: true,
      showNameToPlayers: false,
      showAura1ToPlayers: true,
      showAura2ToPlayers: true
    },
    newCharSettings: {
      sheetOutput: '@{output_to_all}',
      deathSaveOutput: '@{output_to_all}',
      initiativeOutput: '@{output_to_all}',
      showNameOnRollTemplate: '@{show_character_name_yes}',
      rollOptions: '@{normal}',
      initiativeRoll: '@{normal_initiative}',
      initiativeToTracker: '@{initiative_to_tracker_yes}',
      breakInitiativeTies: '@{initiative_tie_breaker_var}',
      showTargetAC: '@{attacks_vs_target_ac_no}',
      showTargetName: '@{attacks_vs_target_name_no}',
      autoAmmo: '@{ammo_auto_use_var}'
    },
    advTrackerSettings: {
      showMarkers: false
    },
    rollHPOnDrop: true,
    autoHD: true,
    genderPronouns: [
      {
        matchPattern: '^f$|female|girl|woman|feminine',
        nominative: 'she',
        accusative: 'her',
        possessive: 'her',
        reflexive: 'herself'
      },
      {
        matchPattern: '^m$|male|boy|man|masculine',
        nominative: 'he',
        accusative: 'him',
        possessive: 'his',
        reflexive: 'himself'
      },
      {
        matchPattern: '^n$|neuter|none|construct|thing|object',
        nominative: 'it',
        accusative: 'it',
        possessive: 'its',
        reflexive: 'itself'
      }
    ],
    defaultGenderIndex: 2

  };

var configToAttributeLookup = {
  sheetOutput: 'output_option',
  deathSaveOutput: 'death_save_output_option',
  initiativeOutput: 'initiative_output_option',
  showNameOnRollTemplate: 'show_character_name',
  rollOptions: 'roll_setting',
  initiativeRoll: 'initiative_roll',
  initiativeToTracker: 'initiative_to_tracker',
  breakInitiativeTies: 'initiative_tie_breaker',
  showTargetAC: 'attacks_vs_target_ac',
  showTargetName: 'attacks_vs_target_name',
  autoAmmo: 'ammo_auto_use'
};

var booleanValidator = function(value) {
  var converted = value === 'true' || (value === 'false' ? false : value);
  return {
    valid: typeof value === 'boolean' || value === 'true' || value === 'false',
    converted: converted
  };
},

  stringValidator = function(value) {
    return {
      valid: true,
      converted: value
    };
  },

  getOptionList = function(options) {
    return function(value) {
      if (value === undefined) {
        return options;
      }
      return {
        converted: options[value],
        valid: options[value] !== undefined
      };
    };
  },

  integerValidator = function(value) {
    var parsed = parseInt(value);
    return {
      converted: parsed,
      valid: !isNaN(parsed)
    };
  },

  colorValidator = function(value) {
    return {
      converted: value,
      valid: /(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(value)
    };
  },

  sheetOutputValidator = getOptionList({
    public: '@{output_to_all}',
    whisper: '@{output_to_gm}'
  }),
  barValidator = {
    attribute: stringValidator,
    max: booleanValidator,
    link: booleanValidator,
    showPlayers: booleanValidator
  },
  auraValidator = {
    radius: stringValidator,
    color: colorValidator,
    square: booleanValidator
  },
  lightValidator = {
    radius: stringValidator,
    dimRadius: stringValidator,
    otherPlayers: booleanValidator,
    hasSight: booleanValidator,
    angle: integerValidator,
    losAngle: integerValidator,
    multiplier: integerValidator
  },
  regExpValidator = function(value) {
    try {
      new RegExp(value, 'i').test('');
      return {
        converted: value,
        valid: true
      };
    }
    catch (e) {
    }
    return {
      converted: null,
      valid: false
    };
  };


/**
 * @typedef {Object} ChatMessage
 * @property {string} content
 * @property {string} type
 * @property {SelectedItem[]} selected
 * @property {string} rolltemplate
 */


/**
 *
 * @typedef {Object} SelectedItem
 * @property {string} _id
 * @property (string _type
 */


module.exports = ShapedScripts;


function ShapedScripts(logger, myState, roll20, parser, entityLookup, reporter) {
  var sanitise = logger.wrapFunction('sanitise', require('./sanitise'), '');
  var addedTokenIds = [];
  var report = reporter.report.bind(reporter);
  var reportError = reporter.reportError.bind(reporter);
  var self = this;
  var chatWatchers = [];
  var at = new AdvantageTracker(logger, myState);

  /**
   *
   * @param {ChatMessage} msg
   */
  this.handleInput = function(msg) {

    try {
      logger.debug(msg);
      if (msg.type !== 'api') {
        this.triggerChatWatchers(msg);
        return;
      }

      this.getCommandProcessor().processCommand(msg);

    }
    catch (e) {
      if (typeof e === 'string' || e instanceof parseModule.ParserError) {
        reportError(e);
        logger.error('Error: $$$', e.toString());
      }
      else {
        logger.error(e.toString());
        logger.error(e.stack);
        reportError('An error occurred. Please see the log for more details.');
      }
    }
    finally {
      logger.prefixString = '';
    }
  };

  var configOptionsSpec = {
    logLevel: function(value) {
      var converted = value.toUpperCase();
      return { valid: _.has(logger, converted), converted: converted };
    },
    tokenSettings: {
      number: booleanValidator,
      bar1: barValidator,
      bar2: barValidator,
      bar3: barValidator,
      aura1: auraValidator,
      aura2: auraValidator,
      light: lightValidator,
      showName: booleanValidator,
      showNameToPlayers: booleanValidator,
      showAura1ToPlayers: booleanValidator,
      showAura2ToPlayers: booleanValidator
    },
    newCharSettings: {
      sheetOutput: sheetOutputValidator,
      deathSaveOutput: sheetOutputValidator,
      initiativeOutput: sheetOutputValidator,
      showNameOnRollTemplate: getOptionList({
        true: '@{show_character_name_yes}',
        false: '@{show_character_name_no}'
      }),
      rollOptions: getOptionList({
        normal: '@{roll_1}',
        advantage: '@{roll_advantage}',
        disadvantage: '@{roll_disadvantage}',
        two: '@{roll_2}'
      }),
      initiativeRoll: getOptionList({
        normal: '@{normal_initiative}',
        advantage: '@{advantage_on_initiative}',
        disadvantage: '@{disadvantage_on_initiative}'
      }),
      initiativeToTracker: getOptionList({
        true: '@{initiative_to_tracker_yes}',
        false: '@{initiative_to_tracker_no}'
      }),
      breakInitiativeTies: getOptionList({
        true: '@{initiative_tie_breaker_var}',
        false: ''
      }),
      showTargetAC: getOptionList({
        true: '@{attacks_vs_target_ac_yes}',
        false: '@{attacks_vs_target_ac_no}'
      }),
      showTargetName: getOptionList({
        true: '@{attacks_vs_target_name_yes}',
        false: '@{attacks_vs_target_name_no}'
      }),
      autoAmmo: getOptionList({
        true: '@{ammo_auto_use_var}',
        false: ''
      })
    },
    advTrackerSettings: {
      showMarkers: booleanValidator,
    },
    rollHPOnDrop: booleanValidator,
    autoHD: booleanValidator,
    genderPronouns: [
      {
        matchPattern: regExpValidator,
        nominative: stringValidator,
        accusative: stringValidator,
        possessive: stringValidator,
        reflexive: stringValidator
      }
    ],
    defaultGenderIndex: integerValidator
  };

  /////////////////////////////////////////
  // Command handlers
  /////////////////////////////////////////
  this.configure = function(options) {
    utils.deepExtend(myState.config, options);

    var cui = new ConfigUI();

    logger.debug('options: ' + options);

    var menu;
    if (options.advTrackerSettings || options.atMenu) {
      menu = cui.getConfigOptionGroupAdvTracker(myState.config, configOptionsSpec);
    }
    else if (options.tokenSettings || options.tsMenu) {
      menu = cui.getConfigOptionGroupTokens(myState.config, configOptionsSpec);
    }
    else if (options.newCharSettings || options.ncMenu) {
      menu = cui.getConfigOptionGroupNewCharSettings(myState.config, configOptionsSpec);
    }
    else {
      menu = cui.getConfigOptionsMenu();
    }

    report('Configuration', menu);
  };

  this.applyTokenDefaults = function(options) {
    var self = this;
    _.each(options.selected.graphic, function(token) {
      var represents = token.get('represents');
      var character = roll20.getObj('character', represents);
      if (character) {
        self.getTokenConfigurer(token)(character);
      }
    });
  };

  this.importStatblock = function(options) {
    logger.info('Importing statblocks for tokens $$$', options.selected.graphic);
    var self = this;
    _.each(options.selected.graphic, function(token) {
      var text = token.get('gmnotes');
      if (text) {
        text = sanitise(unescape(text), logger);
        var monsters = parser.parse(text).monsters;
        mpp(monsters, entityLookup);
        self.importMonsters(monsters, options, token, [
          function(character) {
            character.set('gmnotes', text.replace(/\n/g, '<br>'));
          }
        ]);
      }
    });
  };

  this.importMonstersFromJson = function(options) {

    if (options.all) {
      options.monsters = entityLookup.getAll('monsters');
      delete options.all;
    }

    if (_.isEmpty(options.monsters)) {
      this.showEntityPicker('monster', 'monsters');
    }
    else {
      this.importMonsters(options.monsters.slice(0, 20), options, options.selected.graphic, []);
      options.monsters = options.monsters.slice(20);
      var self = this;
      if (!_.isEmpty(options.monsters)) {
        setTimeout(function() {
          self.importMonstersFromJson(options);
        }, 200);
      }
    }

  };

  this.importMonsters = function(monsters, options, token, characterProcessors) {
    var characterRetrievalStrategies = [];

    if (token) {
      characterProcessors.push(this.getAvatarCopier(token).bind(this));
      if (_.size(monsters) === 1) {
        characterProcessors.push(this.getTokenConfigurer(token).bind(this));
        if (options.replace || options.overwrite) {
          characterRetrievalStrategies.push(this.getTokenRetrievalStrategy(token).bind(this));
        }
      }
    }
    if (options.replace) {
      characterRetrievalStrategies.push(this.nameRetrievalStrategy);
    }

    characterRetrievalStrategies.push(this.creationRetrievalStrategy.bind(this));
    characterProcessors.push(this.monsterDataPopulator.bind(this));

    var errors = [];
    var importedList = _.chain(monsters)
      .map(function(monsterData) {

        var character = _.reduce(characterRetrievalStrategies, function(result, strategy) {
          return result || strategy(monsterData.name, errors);
        }, null);

        if (!character) {
          logger.error('Failed to find or create character for monster $$$', monsterData.name);
          return null;
        }

        var oldAttrs = roll20.findObjs({ type: 'attribute', characterid: character.id });
        _.invoke(oldAttrs, 'remove');
        character.set('name', monsterData.name);

        _.each(characterProcessors, function(proc) {
          proc(character, monsterData);
        });
        return character && character.get('name');
      })
      .compact()
      .value();

    if (!_.isEmpty(importedList)) {
      var monsterList = importedList.join('</li><li>');
      report('Import Success', 'Added the following monsters: <ul><li>' + monsterList + '</li></ul>');
    }
    if (!_.isEmpty(errors)) {
      var errorList = errors.join('</li><li>');
      reportError('The following errors occurred on import:  <ul><li>' + errorList + '</li></ul>');
    }
  };

  this.importSpellsFromJson = function(options) {
    if (_.isEmpty(options.spells)) {
      this.showEntityPicker('spell', 'spells');
    }
    else {
      this.addSpellsToCharacter(options.selected.character, options.spells);
    }
  };

  this.showEntityPicker = function(entityName, entityNamePlural) {
    var list = entityLookup.getKeys(entityNamePlural, true);

    if (!_.isEmpty(list)) {
      // title case the  names for better display
      list.forEach(function(part, index) {
        list[index] = utils.toTitleCase(part);
      });
      // create a clickable button with a roll query to select an entity from the loaded json

      report(utils.toTitleCase(entityName) + ' Importer', '<a href="!shaped-import-' + entityName + ' --?{Pick a ' +
        entityName + '|' + list.join('|') + '}">Click to select a ' + entityName + '</a>');
    }
    else {
      reportError('Could not find any ' + entityNamePlural + '.<br/>Please ensure you have a properly formatted ' +
        entityNamePlural + ' json file.');
    }
  };

  this.addSpellsToCharacter = function(character, spells, noreport) {
    var gender = roll20.getAttrByName(character.id, 'gender');

    var defaultIndex = Math.min(myState.config.defaultGenderIndex, myState.config.genderPronouns.length);
    var defaultPronounInfo = myState.config.genderPronouns[defaultIndex];
    var pronounInfo = _.clone(_.find(myState.config.genderPronouns, function(pronounDetails) {
      return new RegExp(pronounDetails.matchPattern, 'i').test(gender);
    }) || defaultPronounInfo);

    _.defaults(pronounInfo, defaultPronounInfo);


    var importData = {
      spells: srdConverter.convertSpells(spells, pronounInfo)
    };
    this.getImportDataWrapper(character).mergeImportData(importData);
    if (!noreport) {
      report('Import Success', 'Added the following spells:  <ul><li>' + _.map(importData.spells, function(spell) {
        return spell.name;
      }).join('</li><li>') + '</li></ul>');
    }
  };


  this.monsterDataPopulator = function(character, monsterData) {
    _.each(myState.config.newCharSettings, function(value, key) {
      var attribute = roll20.getOrCreateAttr(character.id, configToAttributeLookup[key]);
      attribute.set('current', _.isBoolean(value) ? (value ? 1 : 0) : value);
    });

    var converted = srdConverter.convertMonster(monsterData);
    logger.debug('Converted monster data: $$$', converted);
    var expandedSpells = converted.spells;
    delete converted.spells;
    this.getImportDataWrapper(character).setNewImportData({ npc: converted });
    if (expandedSpells) {
      this.addSpellsToCharacter(character, expandedSpells, true);
    }
    return character;

  };

  this.getTokenRetrievalStrategy = function(token) {
    return function(name, errors) {
      if (token) {
        var character = roll20.getObj('character', token.get('represents'));
        if (character && roll20.getAttrByName(character.id, 'locked')) {
          errors.push('Character with name ' + character.get('name') + ' and id ' + character.id +
            ' was locked and cannot be overwritten');
          return null;
        }
        return character;
      }
    };
  };

  this.nameRetrievalStrategy = function(name, errors) {
    var chars = roll20.findObjs({ type: 'character', name: name });
    if (chars.length > 1) {
      errors.push('More than one existing character found with name "' + name + '". Can\'t replace');
    }
    else {
      if (chars[0] && roll20.getAttrByName(chars[0].id, 'locked')) {
        errors.push('Character with name ' + chars[0].get('name') + ' and id ' + chars[0].id +
          ' was locked and cannot be overwritten');
        return null;
      }
      return chars[0];
    }
  };

  this.creationRetrievalStrategy = function(name, errors) {
    if (!_.isEmpty(roll20.findObjs({ type: 'character', name: name }))) {
      errors.push('Can\'t create new character with name "' + name +
        '" because one already exists with that name. Perhaps you want --replace?');
    }
    else {
      return roll20.createObj('character', { name: name });
    }
  };

  this.getAvatarCopier = function(token) {
    return function(character) {
      character.set('avatar', token.get('imgsrc'));
    };
  };

  this.getTokenConfigurer = function(token) {
    return function(character) {
      token.set('represents', character.id);
      token.set('name', character.get('name'));
      var settings = myState.config.tokenSettings;
      if (settings.number && token.get('name').indexOf('%%NUMBERED%%') === -1) {
        token.set('name', token.get('name') + ' %%NUMBERED%%');
      }

      _.chain(settings)
        .pick(['bar1', 'bar2', 'bar3'])
        .each(function(bar, barName) {
          if (!_.isEmpty(bar.attribute)) {
            var attribute = roll20.getOrCreateAttr(character.id, bar.attribute);
            if (attribute) {
              token.set(barName + '_value', attribute.get('current'));
              if (bar.max) {
                token.set(barName + '_max', attribute.get('max'));
              }
              token.set('showplayers_' + barName, bar.showPlayers);
              if (bar.link) {
                token.set(barName + '_link', attribute.id);
              }
            }
          }
        });

      // auras
      _.chain(settings)
        .pick(['aura1', 'aura2'])
        .each(function(aura, auraName) {
          token.set(auraName + '_radius', aura.radius);
          token.set(auraName + '_color', aura.color);
          token.set(auraName + '_square', aura.square);
        });

      logger.debug('Settings for tokens: $$$', settings);
      token.set('showname', settings.showName);
      token.set('showplayers_name', settings.showNameToPlayers);
      token.set('showplayers_aura1', settings.showAura1ToPlayers);
      token.set('showplayers_aura2', settings.showAura2ToPlayers);
      token.set('light_radius', settings.light.radius);
      token.set('light_dimradius', settings.light.dimRadius);
      token.set('light_otherplayers', settings.light.otherPlayers);
      token.set('light_hassight', settings.light.hasSight);
      token.set('light_angle', settings.light.angle);
      token.set('light_losangle', settings.light.losAngle);
      token.set('light_multiplier', settings.light.multiplier);
    };
  };

  this.getImportDataWrapper = function(character) {


    return {
      setNewImportData: function(importData) {
        if (_.isEmpty(importData)) {
          return;
        }
        roll20.setAttrByName(character.id, 'import_data', JSON.stringify(importData));
        roll20.setAttrByName(character.id, 'import_data_present', 'on');
      },
      mergeImportData: function(importData) {
        if (_.isEmpty(importData)) {
          return;
        }
        var attr = roll20.getOrCreateAttr(character.id, 'import_data');
        var dataPresentAttr = roll20.getOrCreateAttr(character.id, 'import_data_present');
        var current = {};
        try {
          if (!_.isEmpty(attr.get('current').trim())) {
            current = JSON.parse(attr.get('current'));
          }
        }
        catch (e) {
          logger.warn('Existing import_data attribute value was not valid JSON: [$$$]', attr.get('current'));
        }
        _.each(importData, function(value, key) {
          var currentVal = current[key];
          if (currentVal) {
            if (!_.isArray(currentVal)) {
              current[key] = [currentVal];
            }
            current[key] = current[key].concat(value);
          }
          else {
            current[key] = value;
          }

        });
        logger.debug('Setting import data to $$$', current);
        attr.set('current', JSON.stringify(current));
        dataPresentAttr.set('current', 'on');
        return current;
      },

      logWrap: 'importDataWrapper'
    };
  };

  this.applyAdvantageTracker = function(options) {
    var type = 'normal';
    if (options.advantage) {
      type = 'advantage';
    }
    else if (options.disadvantage) {
      type = 'disadvantage';
    }

    at.setMarkers(type, at.buildResources(at.getSelectedCharacters(options.selected.character)));

    //roll20.log('in AT listener');
    //roll20.log(at.buildResources(at.getSelectedCharacters(options.selected.character)));
  };

  /////////////////////////////////////////////////
  // Event Handlers
  /////////////////////////////////////////////////
  this.handleAddToken = function(token) {
    var represents = token.get('represents');
    if (_.isEmpty(represents)) {
      return;
    }
    var character = roll20.getObj('character', represents);
    if (!character) {
      return;
    }
    addedTokenIds.push(token.id);

    //URGH. Thanks Roll20.
    setTimeout((function(id, self) {
      return function() {
        var token = roll20.getObj('graphic', id);
        if (token) {
          self.handleChangeToken(token);
        }
      };
    } (token.id, this)), 100);
  };

  this.handleChangeToken = function(token) {
    if (_.contains(addedTokenIds, token.id)) {
      addedTokenIds = _.without(addedTokenIds, token.id);
      this.rollHPForToken(token);
    }
  };

  this.getHPBar = function() {
    return _.chain(myState.config.tokenSettings)
      .pick('bar1', 'bar2', 'bar3')
      .findKey({ attribute: 'HP' })
      .value();
  };

  this.rollHPForToken = function(token) {
    var hpBar = this.getHPBar();
    logger.debug('HP bar is $$$', hpBar);
    if (!hpBar || !myState.config.rollHPOnDrop) {
      return;
    }

    var represents = token.get('represents');
    if (!represents) {
      return;
    }
    var character = roll20.getObj('character', represents);
    if (!character) {
      return;
    }
    var hpBarLink = token.get(hpBar + '_link');
    if (hpBarLink) {
      return;
    }

    var self = this;
    roll20.sendChat('', '%{' + character.get('name') + '|npc_hp}', function(results) {
      if (results && results.length === 1) {
        var message = self.processInlinerolls(results[0]);
        if (!results[0].inlinerolls || !results[0].inlinerolls[0]) {
          logger.warn('HP roll didn\'t have the expected structure. This is what we got back: $$$', results[0]);
        }
        else {
          var total = results[0].inlinerolls[0].results.total;
          roll20.sendChat('HP Roller', '/w GM &{template:5e-shaped} ' + message);
          token.set(hpBar + '_value', total);
          token.set(hpBar + '_max', total);
        }
      }
    });
  };


  this.registerChatWatcher = function(handler, triggerFields) {
    var matchers = [];
    if (triggerFields && !_.isEmpty(triggerFields)) {
      matchers.push(function(msg, options) {
        return _.intersection(triggerFields, _.keys(options)).length === triggerFields.length;
      });
    }
    chatWatchers.push({ matchers: matchers, handler: handler.bind(this) });
  };

  this.triggerChatWatchers = function(msg) {
    var options = this.getRollTemplateOptions(msg);
    _.each(chatWatchers, function(watcher) {
      if (_.every(watcher.matchers, function(matcher) {
        return matcher(msg, options);
      })) {
        watcher.handler(options, msg);
      }
    });
  };

  /**
   *
   * @param options
   * @param {ChatMessage} msg
   */
  this.handleAmmo = function(options, msg) {

    if (!roll20.getAttrByName(options.character.id, 'ammo_auto_use')) {
      return;
    }

    var ammoAttr = _.chain(roll20.findObjs({ type: 'attribute', characterid: options.character.id }))
      .filter(function(attribute) {
        return attribute.get('name').indexOf('repeating_ammo') === 0;
      })
      .groupBy(function(attribute) {
        return attribute.get('name').replace(/(repeating_ammo_[^_]+).*/, '$1');
      })
      .find(function(attributes) {
        return _.find(attributes, function(attribute) {
          return attribute.get('name').match(/.*name$/) && attribute.get('current') === options.ammoName;
        });
      })
      .find(function(attribute) {
        return attribute.get('name').match(/.*qty$/);
      })
      .value();

    if (!ammoAttr) {
      logger.error('No ammo attribute found corresponding to name $$$', options.ammoName);
      return;
    }

    var ammoUsed = 1;
    if (options.ammo) {
      var rollRef = options.ammo.match(/\$\[\[(\d+)\]\]/);
      if (rollRef) {
        var rollExpr = msg.inlinerolls[rollRef[1]].expression;
        var match = rollExpr.match(/\d+-(\d+)/);
        if (match) {
          ammoUsed = match[1];
        }
      }

    }

    var val = parseInt(ammoAttr.get('current'), 10) || 0;
    ammoAttr.set('current', Math.max(0, val - ammoUsed));
  };

  this.handleHD = function(options, msg) {
    var match = options.title.match(/(\d+)d(\d+) Hit Dice/);
    if (match && myState.config.autoHD) {
      var hdCount = match[1];
      var hdSize = match[2];
      var hdAttr = roll20.getAttrObjectByName(options.character.id, 'hd_d' + hdSize);
      var hpAttr = roll20.getAttrObjectByName(options.character.id, 'HP');
      var newHp = Math.min(parseInt(hpAttr.get('current')) + this.getRollValue(msg, options.roll1), hpAttr.get('max'));

      if (hdAttr) {
        if (hdCount <= hdAttr.get('current')) {
          hdAttr.set('current', hdAttr.get('current') - hdCount);
          hpAttr.set('current', newHp);
        }
        else {
          report('HD Police', options.characterName + ' can\'t use ' + hdCount + 'd' + hdSize +
            ' hit dice because they only have ' + hdAttr.get('current') + ' left');
        }
      }

    }
  };


  this.handleDeathSave = function(options, msg) {

    //TODO: Do we want to output text on death/recovery?
    var increment = function(val) {
      return ++val;
    };
    //TODO: Advantage?
    if (roll20.getAttrByName(options.character.id, 'roll_setting') !== '@{roll_2}') {
      var result = this.getRollValue(msg, options.roll1);
      var attributeToIncrement = result >= 10 ? 'death_saving_throw_successes' : 'death_saving_throw_failures';
      roll20.processAttrValue(options.character.id, attributeToIncrement, increment);
    }

  };

  this.handleFX = function(options, msg) {
    var parts = options.fx.split(' ');
    if (parts.length < 2 || _.some(parts.slice(0, 2), _.isEmpty)) {
      logger.warn('FX roll template variable is not formated correctly: [$$$]', options.fx);
      return;
    }


    var fxType = parts[0],
      pointsOfOrigin = parts[1],
      targetTokenId,
      //sourceTokenId,
      sourceCoords = {},
      targetCoords = {},
      fxCoords = [],
      pageId;

    //noinspection FallThroughInSwitchStatementJS
    switch (pointsOfOrigin) {
      case 'sourceToTarget':
      case 'source':
        targetTokenId = parts[2]; //jshint ignore: line
        fxCoords.push(sourceCoords, targetCoords);
        break;
      case 'targetToSource':
      case 'target':
        targetTokenId = parts[2];
        fxCoords.push(targetCoords, sourceCoords);
    }

    if (targetTokenId) {
      var targetToken = roll20.getObj('graphic', targetTokenId);
      pageId = targetToken.get('_pageid');
      targetCoords.x = targetToken.get('left');
      targetCoords.y = targetToken.get('top');
    }
    else {
      pageId = roll20.getCurrentPage(msg.playerid).id;
    }


    var casterTokens = roll20.findObjs({ type: 'graphic', pageid: pageId, represents: options.character.id });

    if (casterTokens.length) {
      //If there are multiple tokens for the character on this page, then try and find one of them that is selected
      //This doesn't work without a selected token, and the only way we can get this is to use @{selected} which is a pain
      //for people who want to launch without a token selected
      // if(casterTokens.length > 1) {
      //     var selected = _.findWhere(casterTokens, {id: sourceTokenId});
      //     if (selected) {
      //         casterTokens = [selected];
      //     }
      // }
      sourceCoords.x = casterTokens[0].get('left');
      sourceCoords.y = casterTokens[0].get('top');
    }


    if (!fxCoords[0]) {
      logger.warn('Couldn\'t find required point for fx for character $$$, casterTokens: $$$, fxSpec: $$$ ', options.character.id, casterTokens, options.fx);
      return;
    }
    else if (!fxCoords[1]) {
      fxCoords = fxCoords.slice(0, 1);
    }

    roll20.spawnFx(fxCoords, fxType, pageId);
  };

  this.getRollValue = function(msg, rollOutputExpr) {
    var rollIndex = rollOutputExpr.match(/\$\[\[(\d+)\]\]/)[1];
    return msg.inlinerolls[rollIndex].results.total;
  };

  /**
   *
   * @returns {*}
   */
  this.getRollTemplateOptions = function(msg) {
    if (msg.rolltemplate === '5e-shaped') {
      var regex = /\{\{(.*?)\}\}/g;
      var match;
      var options = {};
      while (!!(match = regex.exec(msg.content))) {
        if (match[1]) {
          var splitAttr = match[1].split('=');
          var propertyName = splitAttr[0].replace(/_([a-z])/g, function(match, letter) {
            return letter.toUpperCase();
          });
          options[propertyName] = splitAttr.length === 2 ? splitAttr[1] : '';
        }
      }
      if (options.characterName) {
        options.character = roll20.findObjs({
          _type: 'character',
          name: options.characterName
        })[0];
      }
      return options;
    }
    return {};
  };

  this.processInlinerolls = function(msg) {
    if (_.has(msg, 'inlinerolls')) {
      return _.chain(msg.inlinerolls)
        .reduce(function(previous, current, index) {
          previous['$[[' + index + ']]'] = current.results.total || 0;
          return previous;
        }, {})
        .reduce(function(previous, current, index) {
          return previous.replace(index.toString(), current);
        }, msg.content)
        .value();
    }
    else {
      return msg.content;
    }
  };

  this.addAbility = function(options) {
    if (_.isEmpty(options.abilities)) {
      //TODO report some sort of error?
      return;
    }
    var messages = _.map(options.selected.character, function(character) {

      var operationMessages = _.chain(options.abilities)
        .sortBy('sortKey')
        .map(function(maker) {
          return maker.run(character, options);
        })
        .value();


      if (_.isEmpty(operationMessages)) {
        return '<li>' + character.get('name') + ': Nothing to do</li>';
      }

      var message;
      message = '<li>Configured the following abilities for character ' + character.get('name') + ':<ul><li>';
      message += operationMessages.join('</li><li>');
      message += '</li></ul></li>';

      return message;
    });

    report('Ability Creation', '<ul>' + messages.join('') + '</ul>');

  };

  var getAbilityMaker = function(character) {
    return function(abilitySpec) {
      var ability = roll20.getOrCreateObj('ability', { characterid: character.id, name: abilitySpec.name });
      ability.set({ action: abilitySpec.action, istokenaction: true }); //TODO configure this
      return abilitySpec.name;
    };
  };

  var abilityDeleter = {
    run: function(character) {
      var abilities = roll20.findObjs({ type: 'ability', characterid: character.id });
      var deleted = _.map(abilities, function(obj) {
        var name = obj.get('name');
        obj.remove();
        return name;
      });

      return 'Deleted: ' + (_.isEmpty(deleted) ? 'None' : deleted.join(', '));
    },
    sortKey: ''
  };

  var RepeatingAbilityMaker = function(repeatingSection, abilityName, label, canMark) {
    this.run = function(character, options) {
      options[`cache${repeatingSection}`] = options[`cache${repeatingSection}`] ||
        roll20.getRepeatingSectionItemIdsByName(character.id, repeatingSection);

      var configured = _.chain(options[`cache${repeatingSection}`])
        .map(function(repeatingId, repeatingName) {
          var repeatingAction = '%{' + character.get('name') + '|repeating_' + repeatingSection + '_' + repeatingId +
            '_' + abilityName + '}';
          if (canMark && options.mark) {
            repeatingAction += '\n!mark @{target|token_id}';
          }
          return { name: utils.toTitleCase(repeatingName), action: repeatingAction };
        })
        .map(getAbilityMaker(character))
        .value();
      return label + (_.isEmpty(configured) ? ': Not present for character' : ': ' + configured.join(', '));

    };
    this.sortKey = 'originalOrder';
  };

  var RollAbilityMaker = function(abilityName, newName) {
    this.run = function(character) {
      return getAbilityMaker(character)({
        name: newName,
        action: '%{' + character.get('name') + '|' + abilityName + '}'
      });
    };
    this.sortKey = 'originalOrder';
  };

  var staticAbilityOptions = {
    DELETE: abilityDeleter,
    initiative: new RollAbilityMaker('initiative', 'Init'),
    abilitychecks: new RollAbilityMaker('ability_checks_macro', 'Ability Checks'),
    abilitychecksquery: new RollAbilityMaker('ability_checks_query_macro', 'Ability Checks'),
    abilchecks: new RollAbilityMaker('ability_checks_macro', 'AbilChecks'),
    abilchecksquery: new RollAbilityMaker('ability_checks_query_macro', 'AbilChecks'),
    savingthrows: new RollAbilityMaker('saving_throw_macro', 'Saving Throws'),
    savingthrowsquery: new RollAbilityMaker('saving_throw_query_macro', 'Saving Throws'),
    saves: new RollAbilityMaker('saving_throw_macro', 'Saves'),
    savesquery: new RollAbilityMaker('saving_throw_query_macro', 'Saves'),
    attacks: new RepeatingAbilityMaker('attack', 'attack', 'Attacks', true),
    statblock: new RollAbilityMaker('statblock', 'Statblock'),
    traits: new RepeatingAbilityMaker('trait', 'trait', 'Traits'),
    'traits-macro': new RollAbilityMaker('traits_macro', 'Traits'),
    actions: new RepeatingAbilityMaker('action', 'action', 'Actions', true),
    'actions-macro': new RollAbilityMaker('actions_macro', 'Actions'),
    reactions: new RepeatingAbilityMaker('reaction', 'action', 'Reactions'),
    'reactions-macro': new RollAbilityMaker('reactions_macro', 'Reactions'),
    legendaryactions: new RepeatingAbilityMaker('legendaryaction', 'action', 'Legendary Actions'),
    'legendaryactions-macro': new RollAbilityMaker('legendaryactions_macro', 'Legendary Actions'),
    legendarya: new RepeatingAbilityMaker('legendaryaction', 'action', 'LegendaryA'),
    lairactions: new RollAbilityMaker('lairactions_macro', 'Lair Actions'),
    laira: new RollAbilityMaker('lairactions_macro', 'LairA'),
    regionaleffects: new RollAbilityMaker('regionaleffects_macro', 'Regional Effects'),
    regionale: new RollAbilityMaker('regionaleffects_macro', 'RegionalE')
  };

  var abilityLookup = function(optionName, existingOptions) {
    var maker = staticAbilityOptions[optionName];

    //Makes little sense to add named spells to multiple characters at once
    if (!maker && existingOptions.selected.character.length === 1) {

      existingOptions.spellToRepeatingIdLookup = existingOptions.spellToRepeatingIdLookup ||
        roll20.getRepeatingSectionItemIdsByName(existingOptions.selected.character[0].id, 'spell');

      var repeatingId = existingOptions.spellToRepeatingIdLookup[optionName.toLowerCase()];
      if (repeatingId) {
        maker = new RollAbilityMaker('repeating_spell_' + repeatingId + '_spell', utils.toTitleCase(optionName));
      }
    }
    return maker;
  };


  this.getCommandProcessor = function() {
    return cp('shaped')
      .addCommand('config', this.configure.bind(this))
      .options(configOptionsSpec)
      .option('atMenu', booleanValidator)
      .option('tsMenu', booleanValidator)
      .option('ncMenu', booleanValidator)
      .addCommand('import-statblock', self.importStatblock.bind(self))
      .option('overwrite', booleanValidator)
      .option('replace', booleanValidator)
      .withSelection({
        graphic: {
          min: 1,
          max: Infinity
        }
      })
      .addCommand(['import-monster', 'monster'], this.importMonstersFromJson.bind(this))
      .option('all', booleanValidator)
      .optionLookup('monsters', entityLookup.findEntity.bind(entityLookup, 'monsters'))
      .option('overwrite', booleanValidator)
      .option('replace', booleanValidator)
      .withSelection({
        graphic: {
          min: 0,
          max: 1
        }
      })
      .addCommand(['import-spell', 'spell'], this.importSpellsFromJson.bind(this))
      .optionLookup('spells', entityLookup.findEntity.bind(entityLookup, 'spells'))
      .withSelection({
        character: {
          min: 1,
          max: 1
        }
      })
      .addCommand('at', this.applyAdvantageTracker.bind(this))
      .option('advantage', booleanValidator)
      .option('disadvantage', booleanValidator)
      .option('normal', booleanValidator)
      .withSelection({
        character: {
          min: 1,
          max: Infinity
        }
      })
      .addCommand('abilities', this.addAbility.bind(this))
      .withSelection({
        character: {
          min: 1,
          max: Infinity
        }
      })
      .optionLookup('abilities', abilityLookup)
      .option('mark', booleanValidator)
      .addCommand('token-defaults', this.applyTokenDefaults.bind(this))
      .withSelection({
        graphic: {
          min: 1,
          max: Infinity
        }
      })
      .end();
  };

  this.checkInstall = function() {
    logger.info('-=> ShapedScripts v$$$ <=-', version);
    if (myState.version !== schemaVersion) {
      logger.info('  > Updating Schema to v$$$ from $$$<', schemaVersion, myState && myState.version);
      logger.info('Preupgrade state: $$$', myState);
      //noinspection FallThroughInSwitchStatementJS
      switch (myState && myState.version) {
        case 0.1:
        case 0.2:
        case 0.3:
          _.extend(myState.config.genderPronouns, utils.deepClone(configDefaults.genderPronouns)); //jshint ignore: line
        case 0.4:
        case 0.5:
        case 0.6:
        case 0.7:
        case 0.8:
        case 0.9:
          _.defaults(myState.config, utils.deepClone(configDefaults));
          _.defaults(myState.config.tokenSettings, utils.deepClone(configDefaults.tokenSettings));
          _.defaults(myState.config.newCharSettings, utils.deepClone(configDefaults.newCharSettings));
          _.defaults(myState.config.advTrackerSettings, utils.deepClone(configDefaults.advTrackerSettings));
          myState.version = schemaVersion;
          break;
        default:
          if (!myState.version) {
            _.defaults(myState, {
              version: schemaVersion,
              config: utils.deepClone(configDefaults)
            });
            logger.info('Making new state object $$$', myState);
          }
          else {
            logger.error('Unknown schema version for state $$$', myState);
            reportError('Serious error attempting to upgrade your global state, please see log for details. ' +
              'ShapedScripts will not function correctly until this is fixed');
            myState = undefined;
          }
          break;
      }
      logger.info('Upgraded state: $$$', myState);
    }
  };

  this.registerEventHandlers = function() {
    roll20.on('chat:message', this.handleInput.bind(this));
    roll20.on('add:token', this.handleAddToken.bind(this));
    roll20.on('change:token', this.handleChangeToken.bind(this));
    roll20.on('add:graphic', function(token) {
      logger.debug('on add:graphic');
      at.updateToken(token);
    });
    roll20.on('change:graphic', function(token) {
      logger.debug('on change:graphic');
      at.updateToken(token);
    });
    roll20.on('change:attribute', function(msg) {
      if (msg.get('name') === 'roll_setting') {
        at.updateSetting(msg);
      }
    });
    this.registerChatWatcher(this.handleDeathSave, ['deathSavingThrow', 'character', 'roll1']);
    this.registerChatWatcher(this.handleAmmo, ['ammoName', 'character']);
    this.registerChatWatcher(this.handleFX, ['fx', 'character']);
    this.registerChatWatcher(this.handleHD, ['character', 'title']);
  };

  logger.wrapModule(this);
}

ShapedScripts.prototype.logWrap = 'ShapedScripts';





