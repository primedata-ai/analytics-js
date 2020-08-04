/*
 * Licensed to the Apache Software Foundation (ASF) under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * The ASF licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var integration = require('@segment/analytics.js-integration');
var extend  = require('extend');

var Prime = (module.exports = integration('Prime Data')
    .global('cxs')
    .assumesPageview()
    .readyOnLoad()
    .option('scope', '')
    .option('writeKey', '')
    .option('sessionTimeOut', 30*60*1000)
    .option('url', 'http://localhost:8181')
    .option('timeoutInMilliseconds', 3000)
    .option('sessionCookieName', 'XSessionId')
    .option('sessionId'));

/**
 * Initialize.
 *
 * @api public
 */
Prime.prototype.initialize = function() {
    var self = this;
    this.analytics.on('invoke', function(msg) {
        var action = msg.action();
        var listener = 'on' + msg.action();
        self.debug('%s %o', action, msg);
        if (self[listener]) self[listener](msg);
    });

    this.analytics.personalize = function(personalization, callback) {
        this.emit('invoke', {action:function() {return "personalize"}, personalization:personalization, callback:callback});
    };

    // Standard to check if cookies are enabled in this browser
    if (!navigator.cookieEnabled) {
        this.executeFallback();
        return;
    }

    // digitalData come from a standard so we can keep the logic around it which can allow complex website to load more complex data
    window.digitalData = window.digitalData || {
        scope: self.options.scope
    };

    window.digitalData.page = window.digitalData.page || {
        pageInfo: {
            pageName: document.title,
            pagePath : location.pathname + location.hash,
            destinationURL: location.href
        }
    }

    var primePage = window.digitalData.page;
    var context = this.context();
    if (!primePage) {
        primePage = window.digitalData.page = { pageInfo:{} }
    }
    if (self.options.initialPageProperties) {
        var props = self.options.initialPageProperties;
        this.fillPageData(primePage, props);
    }
    window.digitalData.events = window.digitalData.events || [];
    window.digitalData.events.push(this.buildEvent('view', this.buildPage(primePage), this.buildSource(location.href, 'page', context)))

    this.extendSessionID()
    setTimeout(self.loadContext.bind(self), 0);
};

/**
 * Loaded.
 *
 * @api private
 * @return {boolean}
 */
Prime.prototype.loaded = function() {
    return !!window.cxs;
};

/**
 * Page.
 *
 * @api public
 * @param {Page} page
 */
Prime.prototype.page = function(page) {
    var primePage = { };
    this.fillPageData(primePage, page.json().properties);

    this.collectEvent(this.buildEvent('view', this.buildPage(primePage), this.buildSource(location.href, 'page')));
};

Prime.prototype.fillPageData = function(primePage, props) {
    primePage.attributes = [];
    primePage.consentTypes = [];
    primePage.interests = props.interests || {};
    primePage.pageInfo = extend({}, primePage.pageInfo, props.pageInfo);
    primePage.pageInfo.pageName = primePage.pageInfo.pageName || props.title;
    primePage.pageInfo.pagePath = primePage.pageInfo.pagePath || props.path;
    primePage.pageInfo.pagePath = primePage.pageInfo.pagePath || props.path;
    primePage.pageInfo.destinationURL = primePage.pageInfo.destinationURL || props.url;
    primePage.pageInfo.referringURL = document.referrer;
    this.processReferrer();
};

Prime.prototype.processReferrer = function() {
    var referrerURL = document.referrer;
    if (referrerURL) {
        // parse referrer URL
        var referrer = document.createElement('a');
        referrer.href = referrerURL;

        // only process referrer if it's not coming from the same site as the current page
        var local = document.createElement('a');
        local.href = document.URL;
        if (referrer.host !== local.host) {
            // get search element if it exists and extract search query if available
            var search = referrer.search;
            var query = undefined;
            if (search && search != '') {
                // parse parameters
                var queryParams = [], param;
                var queryParamPairs = search.slice(1).split('&');
                for (var i = 0; i < queryParamPairs.length; i++) {
                    param = queryParamPairs[i].split('=');
                    queryParams.push(param[0]);
                    queryParams[param[0]] = param[1];
                }

                // try to extract query: q is Google-like (most search engines), p is Yahoo
                query = queryParams.q || queryParams.p;
                query = decodeURIComponent(query).replace(/\+/g, ' ');
            }

            // add data to digitalData
            if (window.digitalData && window.digitalData.page && window.digitalData.page.pageInfo) {
                window.digitalData.page.pageInfo.referrerHost = referrer.host;
                window.digitalData.page.pageInfo.referrerQuery = query;
            }

            // register referrer event
            this.registerEvent(this.buildEvent('viewFromReferrer', this.buildTargetPage()));
        }
    }
};


/**
 * Identify.
 *
 * @api public
 * @param {Identify} identify
 */
Prime.prototype.identify = function(identify) {
    this.collectEvent(this.buildEvent("identify",
        this.buildTarget(identify.userId(), "analyticsUser", identify.traits()),
        this.buildSource(location.href, 'page', identify.context())));
};

/**
 * ontrack.
 *
 * @api private
 * @param {Track} track
 */
Prime.prototype.track = function(track) {
    // we use the track event name to know that we are submitted a form because Analytics.js trackForm method doesn't give
    // us another way of knowing that we are processing a form.
    var arg = track.properties();
    var target = arg.track || this.buildTargetPage();
    var source = arg.source || this.buildSource(location.href, 'page', window.digitalData.page);
    var props = arg.properties;
    if (track.event() && track.event().indexOf("form") === 0) {
        var form = document.forms[track.properties().formName];
        var formEvent = this.buildFormEvent(form.name);
        formEvent.properties = this.extractFormData(form);
        this.collectEvent(formEvent);
    } else {
        this.collectEvent(this.buildEvent(track.event(),
            target,
            source,
            props
        ));
    }
};

/**
 * This function is used to load the current context in the page
 *
 * @param {boolean} [skipEvents=false] Should we send the events
 * @param {boolean} [invalidate=false] Should we invalidate the current context
 */
Prime.prototype.loadContext = function (skipEvents, invalidate) {
    this.extendSessionID();
    this.contextLoaded = true;
    var context = this.context();
    var jsonData = {
        requiredProfileProperties: ['j:nodename'],
        source: this.buildPage(window.digitalData.page, 'page', context)
    };
    var now = new Date();
    jsonData.sendAt = now.toISOString();
    if (!skipEvents) {
        jsonData.events = window.digitalData.events
    }
    if (window.digitalData.personalizationCallback) {
        jsonData.personalizations = window.digitalData.personalizationCallback.map(function (x) {
            return x.personalization
        })
    }

    jsonData.sessionId = this.sessionId;

    var contextUrl = this.options.url + '/context';
    if (invalidate) {
        contextUrl += '?invalidateSession=true&invalidateProfile=true';
    }

    var self = this;

    var onSuccess = function (xhr) {

        window.cxs = JSON.parse(xhr.responseText);

        self.ready();

        if (window.digitalData.loadCallbacks) {
            console.info('[Tracker] Found context server load callbacks, calling now...');
            for (var i = 0; i < window.digitalData.loadCallbacks.length; i++) {
                window.digitalData.loadCallbacks[i](digitalData);
            }
        }
        if (window.digitalData.personalizationCallback) {
            console.info('[Tracker] Found context server personalization, calling now...');
            for (var i = 0; i < window.digitalData.personalizationCallback.length; i++) {
                window.digitalData.personalizationCallback[i].callback(cxs.personalizations[window.digitalData.personalizationCallback[i].personalization.id]);
            }
        }
    };

    this.ajax({
        url: contextUrl,
        type: 'POST',
        async: true,
        contentType: 'text/plain;charset=UTF-8', // Use text/plain to avoid CORS preflight
        jsonData: jsonData,
        dataType: 'application/json',
        invalidate: invalidate,
        success: onSuccess,
        error: this.executeFallback
    });
    console.info('[Tracker] Context loading...');
};

Prime.prototype.onpersonalize = function (msg) {
    if (this.contextLoaded) {
        console.error('[Tracker] Already loaded, too late...');
        return;
    }
    window.digitalData = window.digitalData || {
        scope: this.options.scope
    };
    window.digitalData.personalizationCallback = window.digitalData.personalizationCallback || [];
    window.digitalData.personalizationCallback.push({personalization: msg.personalization, callback: msg.callback});
};

/**
 * This function return the basic structure for an event, it must be adapted to your need
 *
 * @param {string} eventType The name of your event
 * @param {object} [target] The target object for your event can be build with this.buildTarget(targetId, targetType, targetProperties)
 * @param {object} [source] The source object for your event can be build with this.buildSource(sourceId, sourceType, sourceProperties)
 * @param {object} [properties] a map of properties for the event
 * @returns {{eventType: *, scope}}
 */
Prime.prototype.buildEvent = function (eventType, target, source, properties) {
    var event = {
        eventType: eventType,
        scope: window.digitalData.scope,
        timeStamp: (new Date()).toISOString()
    };

    if (target) {
        event.target = target;
    }

    if (source) {
        event.source = source;
    }

    if (properties) {
        event.properties = properties;
    }

    return event;
};

/**
 * This function return an event of type form
 *
 * @param {string} formName The HTML name of id of the form to use in the target of the event
 * @returns {*|{eventType: *, scope, source: {scope, itemId: string, itemType: string, properties: {}}, target: {scope, itemId: string, itemType: string, properties: {}}}}
 */
Prime.prototype.buildFormEvent = function (formName) {
    return this.buildEvent('form', this.buildTarget(formName, 'form'), this.buildSourcePage());
};

/**
 * This function return the source object for a source of type page
 *
 * @returns {*|{scope, itemId: *, itemType: *}}
 */
Prime.prototype.buildTargetPage = function () {
    return this.buildTarget(window.digitalData.page.pageInfo.pagePath, 'page');
};

/**
 * This function return the source object for a source of type page
 *
 * @returns {*|{scope, itemId: *, itemType: *}}
 */
Prime.prototype.buildSourcePage = function () {
    return this.buildSource(window.digitalData.page.pageInfo.pagePath, 'page', window.digitalData.page);
};


/**
 * This function return the source object for a source of type page
 *
 * @returns {*|{scope, itemId: *, itemType: *}}
 */
Prime.prototype.buildPage = function (page) {
    return this.buildSource(page.pageInfo.pagePath, 'page', page);
};

/**
 * This function return the basic structure for the target of your event
 *
 * @param {string} targetId The ID of the target
 * @param {string} targetType The type of the target
 * @param {object} [targetProperties] The optional properties of the target
 * @returns {{scope, itemId: *, itemType: *}}
 */
Prime.prototype.buildTarget = function (targetId, targetType, targetProperties) {
    return this.buildObject(targetId, targetType, targetProperties);
};

/**
 * This function return the basic structure for the source of your event
 *
 * @param {string} sourceId The ID of the source
 * @param {string} sourceType The type of the source
 * @param {object} [sourceProperties] The optional properties of the source
 * @returns {{scope, itemId: *, itemType: *}}
 */
Prime.prototype.buildSource = function (sourceId, sourceType, sourceProperties) {
    return this.buildObject(sourceId, sourceType, sourceProperties);
};


/**
 * This function will send an event to Prime Data
 * @param {object} event The event object to send, you can build it using this.buildEvent(eventType, target, source)
 * @param {function} successCallback will be executed in case of success
 * @param {function} errorCallback will be executed in case of error
 */
Prime.prototype.collectEvent = function (event, successCallback, errorCallback) {
    this.collectEvents({events: [event]}, successCallback, errorCallback);
};

/**
 * This function will send the events to Prime Data
 *
 * @param {object} events Javascript object { events: [event1, event2] }
 * @param {function} successCallback will be executed in case of success
 * @param {function} errorCallback will be executed in case of error
 */
Prime.prototype.collectEvents = function (events, successCallback, errorCallback) {
    events.sessionId = this.sessionId;

    var data = JSON.stringify(events);
    this.ajax({
        url: this.options.url + '/smile',
        type: 'POST',
        async: true,
        contentType: 'text/plain;charset=UTF-8', // Use text/plain to avoid CORS preflight
        data: data,
        dataType: 'application/json',
        success: successCallback,
        error: errorCallback
    });
};

/*******************************/
/* Private Function under this */
/*******************************/

Prime.prototype.registerEvent = function (event) {
    if (window.digitalData) {
        if (window.cxs) {
            console.error('[Tracker] already loaded, too late...');
        } else {
            window.digitalData.events = window.digitalData.events || [];
            window.digitalData.events.push(event);
        }
    } else {
        window.digitalData = {};
        window.digitalData.events = window.digitalData.events || [];
        window.digitalData.events.push(event);
    }
};

Prime.prototype.registerCallback = function (onLoadCallback) {
    if (window.digitalData) {
        if (window.cxs) {
            console.info('[Tracker] digitalData object loaded, calling on load callback immediately and registering update callback...');
            if (onLoadCallback) {
                onLoadCallback(window.digitalData);
            }
        } else {
            console.info('[Tracker] digitalData object present but not loaded, registering load callback...');
            if (onLoadCallback) {
                window.digitalData.loadCallbacks = window.digitalData.loadCallbacks || [];
                window.digitalData.loadCallbacks.push(onLoadCallback);
            }
        }
    } else {
        console.info('[Tracker] No digital data object found, creating and registering update callback...');
        window.digitalData = {};
        if (onLoadCallback) {
            window.digitalData.loadCallbacks = [];
            window.digitalData.loadCallbacks.push(onLoadCallback);
        }
    }
};

/**
 * This is an utility function to generate a new UUID
 *
 * @returns {string}
 */
Prime.prototype.generateGuid = function () {
    function s4() {
        return Math.floor((1 + Math.random()) * 0x10000)
            .toString(16)
            .substring(1);
    }

    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
        s4() + '-' + s4() + s4() + s4();
};

Prime.prototype.buildObject = function (itemId, itemType, properties) {
    var object = {
        scope: window.digitalData.scope,
        itemId: itemId,
        itemType: itemType
    };

    if (properties) {
        object.properties = properties;
    }

    return object;
};

/**
 * This is an utility function to execute AJAX call
 *
 * @param {object} ajaxOptions
 */
Prime.prototype.ajax = function (ajaxOptions) {
    var xhr = new XMLHttpRequest();
    if ('withCredentials' in xhr) {
        xhr.open(ajaxOptions.type, ajaxOptions.url, ajaxOptions.async);
        xhr.withCredentials = true;
    } else if (typeof XDomainRequest != 'undefined') {
        xhr = new XDomainRequest();
        xhr.open(ajaxOptions.type, ajaxOptions.url);
    }

    if (ajaxOptions.contentType) {
        xhr.setRequestHeader('Content-Type', ajaxOptions.contentType);
    }
    if (ajaxOptions.dataType) {
        xhr.setRequestHeader('Accept', ajaxOptions.dataType);
    }
    xhr.setRequestHeader('X-Client-Id', this.options.scope)
    xhr.setRequestHeader('X-Client-Access-Token', this.options.writeKey)

    if (ajaxOptions.responseType) {
        xhr.responseType = ajaxOptions.responseType;
    }

    var requestExecuted = false;
    if (this.options.timeoutInMilliseconds !== -1) {
        setTimeout(function () {
            if (!requestExecuted) {
                console.error('[Tracker] XML request timeout, url: ' + ajaxOptions.url);
                requestExecuted = true;
                if (ajaxOptions.error) {
                    ajaxOptions.error(xhr);
                }
            }
        }, this.options.timeoutInMilliseconds);
    }

    xhr.onreadystatechange = function () {
        if (!requestExecuted) {
            if (xhr.readyState === 4) {
                if (xhr.status === 200 || xhr.status === 204 || xhr.status === 304) {
                    if (xhr.responseText != null) {
                        requestExecuted = true;
                        if (ajaxOptions.success) {
                            ajaxOptions.success(xhr);
                        }
                    }
                } else {
                    requestExecuted = true;
                    if (ajaxOptions.error) {
                        ajaxOptions.error(xhr);
                    }
                    console.error('[Tracker] XML request error: ' + xhr.statusText + ' (' + xhr.status + ')');
                }
            }
        }
    };

    if (ajaxOptions.jsonData) {
        xhr.send(JSON.stringify(ajaxOptions.jsonData));
    } else if (ajaxOptions.data) {
        xhr.send(ajaxOptions.data);
    } else {
        xhr.send();
    }
};

Prime.prototype.executeFallback = function () {
    console.warn('[Tracker] execute fallback');
    window.cxs = {};
    for (var index in window.digitalData.loadCallbacks) {
        window.digitalData.loadCallbacks[index]();
    }
    if (window.digitalData.personalizationCallback) {
        for (var i = 0; i < window.digitalData.personalizationCallback.length; i++) {
            window.digitalData.personalizationCallback[i].callback([window.digitalData.personalizationCallback[i].personalization.strategyOptions.fallback]);
        }
    }
};

Prime.prototype.extendSessionID = function(){
    if (!this.options.sessionId) {
        var cookie = require('component-cookie');

        this.sessionId = cookie(this.options.sessionCookieName);
        // so we should not need to implement our own
        if (!this.sessionId || this.sessionId === '') {
            this.sessionId = this.generateGuid();
        }
    } else {
        this.sessionId = this.options.sessionId;
    }
    cookie(this.options.sessionCookieName, this.sessionId, {maxage: this.options.sessionTimeOut});
}

var utm = require('utm-params-saver');
Prime.prototype.context = function () {
    var width = window.innerWidth
        || document.documentElement.clientWidth
        || document.body.clientWidth;

    var height = window.innerHeight
        || document.documentElement.clientHeight
        || document.body.clientHeight;
    var connectionType = navigator.connection.type || navigator.connection.effectiveType;
    var data = utm.default.parse()
    data.screen_width = width;
    data.screen_height = height;
    data.connection_type = connectionType;
    return data
}

Prime.prototype.extractFormData = function (form) {
    var params = {};
    for (var i = 0; i < form.elements.length; i++) {
        var e = form.elements[i];
        if (typeof(e.name) != 'undefined') {
            switch (e.nodeName) {
                case 'TEXTAREA':
                case 'INPUT':
                    switch (e.type) {
                        case 'checkbox':
                            var checkboxes = document.querySelectorAll('input[name="' + e.name + '"]');
                            if (checkboxes.length > 1) {
                                if (!params[e.name]) {
                                    params[e.name] = [];
                                }
                                if (e.checked) {
                                    params[e.name].push(e.value);
                                }

                            }
                            break;
                        case 'radio':
                            if (e.checked) {
                                params[e.name] = e.value;
                            }
                            break;
                        default:
                            if (!e.value || e.value === '') {
                                // ignore element if no value is provided
                                break;
                            }
                            params[e.name] = e.value;
                    }
                    break;
                case 'SELECT':
                    if (e.options && e.options[e.selectedIndex]) {
                        if (e.multiple) {
                            params[e.name] = [];
                            for (var j = 0; j < e.options.length; j++) {
                                if (e.options[j].selected) {
                                    params[e.name].push(e.options[j].value);
                                }
                            }
                        } else {
                            params[e.name] = e.options[e.selectedIndex].value;
                        }
                    }
                    break;
                default:
                    console.warn("[Tracker] " + e.nodeName + " form element type not implemented and will not be tracked.");
            }
        }
    }
    return params;
};
