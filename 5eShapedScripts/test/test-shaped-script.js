/* globals describe: false, it:false */
require('chai').should();
const _ = require('underscore');
const roll20 = require('../lib/roll20');
const getShaped = require('../lib/shaped-script');
const sinon = require('sinon');


describe('shaped-script', function () {
    'use strict';

    var logger = {};
    _.each(['trace', 'debug', 'info', 'warn', 'error', 'wrapFunction', 'wrapModule'], function (level) {
        logger[level] = _.noop;
    });


    var roll20Mock = sinon.stub(roll20);
    var characterStub = {id: 'myid'};

    /**
     * Test attribute
     * @param name
     * @param value
     * @constructor
     */
    function Attribute(name, value) {
        this.name = name;
        this.value = value;
    }

    Attribute.prototype.get = function (propName) {
        switch (propName) {
            case 'current':
                return this.value;
            case 'name':
                return this.name;
            default:
                throw 'Unrecognised property name ' + propName;
        }
    };

    var arrowsQty = new Attribute('repeating_ammo_YYY_qty', 50);

    var attributeArray = [
        new Attribute('normalAttr', 'someVal'),
        new Attribute('anotherNormalAttr', 'someVal'),
        new Attribute('repeating_foo_XXX_something', 'someVal'),
        new Attribute('repeating_foo_XXX_other', 'someVal'),
        new Attribute('repeating_foo_YYY_something', 'someVal'),
        new Attribute('repeating_foo_YYY_other', 'someVal'),
        new Attribute('repeating_ammo_XXX_qty', 20),
        new Attribute('repeating_ammo_XXX_weight', 0.25),
        new Attribute('repeating_ammo_XXX_name', 'bolts'),
        arrowsQty,
        new Attribute('repeating_ammo_YYY_name', 'arrows'),
        new Attribute('repeating_ammo_YYY_weight', 0.1)
    ];

    roll20Mock.findObjs.withArgs({_type: 'character', name: 'Bob'}).returns([characterStub]);
    roll20Mock.findObjs.withArgs({type: 'attribute', characterid: characterStub.id}).returns(attributeArray);

    var shapedScript = getShaped(logger, {config: {updateAmmo: true}}, roll20Mock, null);

    describe('checkForAmmoUpdate', function () {
        var msg = {
            rolltemplate: '5e-shaped',
            content: '{{ammo_name=arrows}}{{character_name=Bob}}'
        };

        var setVals = {};

        arrowsQty.set = function (propName, value) {
            setVals[propName] = value;
        };

        shapedScript.checkForAmmoUpdate(msg);

        it('should decrement ammo correctly', function () {
            //noinspection JSUnresolvedVariable
            return setVals.should.deep.equal({current: 49});
        });
    });

});