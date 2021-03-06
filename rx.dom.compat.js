// Copyright (c) Microsoft Open Technologies, Inc. All rights reserved. See License.txt in the project root for license information.

;(function (factory) {
    var objectTypes = {
        'boolean': false,
        'function': true,
        'object': true,
        'number': false,
        'string': false,
        'undefined': false
    };

    var root = (objectTypes[typeof window] && window) || this,
        freeExports = objectTypes[typeof exports] && exports && !exports.nodeType && exports,
        freeModule = objectTypes[typeof module] && module && !module.nodeType && module,
        moduleExports = freeModule && freeModule.exports === freeExports && freeExports,
        freeGlobal = objectTypes[typeof global] && global;
    
    if (freeGlobal && (freeGlobal.global === freeGlobal || freeGlobal.window === freeGlobal)) {
        root = freeGlobal;
    }

    // Because of build optimizers
    if (typeof define === 'function' && define.amd) {
        define(['rx', 'exports'], function (Rx, exports) {
            root.Rx = factory(root, exports, Rx);
            return root.Rx;
        });
    } else if (typeof module === 'object' && module && module.exports === freeExports) {
        module.exports = factory(root, module.exports, require('./rx'));
    } else {
        root.Rx = factory(root, {}, root.Rx);
    }
}.call(this, function (root, exp, Rx, undefined) {
    
    var Observable = Rx.Observable,
        observableProto = Observable.prototype,
        AnonymousObservable = Rx.Internals.AnonymousObservable,
        observableCreate = Observable.create,
        observableCreateWithDisposable = Observable.createWithDisposable,
        disposableCreate = Rx.Disposable.create,
        CompositeDisposable = Rx.CompositeDisposable,
        SingleAssignmentDisposable = Rx.SingleAssignmentDisposable,
        AsynsSubject = Rx.AsynsSubject,
        Subject = Rx.Subject,
        Scheduler = Rx.Scheduler,
        defaultNow = (function () { return !!Date.now ? Date.now : function () { return +new Date; }; }()),
        dom = Rx.DOM = {},
        ajax = Rx.DOM.Request = {},
        hasOwnProperty = {}.hasOwnProperty;

    function fixEvent(event) {
        var stopPropagation = function () {
            this.cancelBubble = true;
        };

        var preventDefault = function () {
            this.bubbledKeyCode = this.keyCode;
            if (this.ctrlKey) {
                try {
                    this.keyCode = 0;
                } catch (e) { }
            }
            this.defaultPrevented = true;
            this.returnValue = false;
            this.modified = true;
        };

        event || (event = window.event);
        if (!event.target) {
            event.target = event.target || event.srcElement; 

            if (event.type == 'mouseover') {
                event.relatedTarget = event.fromElement;
            }
            if (event.type == 'mouseout') {
                event.relatedTarget = event.toElement;
            }
            // Adding stopPropogation and preventDefault to IE
            if (!event.stopPropagation){
                event.stopPropagation = stopPropagation;
                event.preventDefault = preventDefault;
            }
            // Normalize key events
            switch(event.type){
                case 'keypress':
                    var c = ('charCode' in event ? event.charCode : event.keyCode);
                    if (c == 10) {
                        c = 0;
                        event.keyCode = 13;
                    } else if (c == 13 || c == 27) {
                        c = 0; 
                    } else if (c == 3) {
                        c = 99; 
                    }
                    event.charCode = c;
                    event.keyChar = event.charCode ? String.fromCharCode(event.charCode) : '';
                    break;
            }                    
        }

        return event;
    }

    function createListener (element, name, handler) {
        // Node.js specific
        if (element.addListener) {
            element.addListener(name, handler);
            return disposableCreate(function () {
                element.removeListener(name, handler);
            });
        }
        // Standards compliant
        if (element.addEventListener) {
            element.addEventListener(name, handler, false);
            return disposableCreate(function () {
                element.removeEventListener(name, handler, false);
            });
        } else if (element.attachEvent) {
            // IE Specific
            var innerHandler = function (event) {
                handler(fixEvent(event));
            };
            element.attachEvent('on' + name, innerHandler);
            return disposableCreate(function () {
                element.detachEvent('on' + name, innerHandler);
            });         
        } else {
            // Level 1 DOM Events      
            element['on' + name] = handler;
            return disposableCreate(function () {
                element['on' + name] = null;
            });
        }
    }

    function createEventListener (el, eventName, handler) {
        var disposables = new CompositeDisposable();

        // Asume NodeList
        if (el && el.length) {
            for (var i = 0, len = el.length; i < len; i++) {
                disposables.add(createEventListener(el[i], eventName, handler));
            }
        } else if (el) {
            disposables.add(createListener(el, eventName, handler));
        }

        return disposables;
    }

    /**
     * Creates an observable sequence by adding an event listener to the matching DOMElement or each item in the NodeList.
     *
     * @example
     *   var source = Rx.Observable.fromEvent(element, 'mouseup');
     * 
     * @param {Object} element The DOMElement or NodeList to attach a listener.
     * @param {String} eventName The event name to attach the observable sequence.
     * @param {Function} [selector] A selector which takes the arguments from the event handler to produce a single item to yield on next.
     * @returns {Observable} An observable sequence of events from the specified element and the specified event.
     */
    dom.fromEvent = function (element, eventName, selector) {
        return observableCreate(function (observer) {
            return createEventListener(
                element, 
                eventName, 
                function handler (e) { 
                    var results = e;

                    if (selector) {
                        try {
                            results = selector(arguments);
                        } catch (err) {
                            observer.onError(err);
                            return
                        }
                    }

                    observer.onNext(results); 
                });
        }).publish().refCount();
    };

    /* @private 
     * Gets the proper XMLHttpRequest for support for older IE 
     */
    function getXMLHttpRequest() {
        if (root.XMLHttpRequest) {
            return new root.XMLHttpRequest;
        } else {
            try {
                return new root.ActiveXObject('Microsoft.XMLHTTP');
            } catch (e) {
                throw new Error('XMLHttpRequest is not supported by your browser');
            }
        }
    }

    /**
     * Creates a cold observable for an Ajax request with either a settings object with url, headers, etc or a string for a URL.
     *
     * @example 
     *   source = Rx.DOM.Request.ajaxCold('/products');
     *   source = Rx.DOM.Request.ajaxCold( url: 'products', method: 'GET' });
     *     
     * @param {Object} settings Can be one of the following:
     *
     *  A string of the URL to make the Ajax call.
     *  An object with the following properties
     *   - url: URL of the request
     *   - method: Method of the request, such as GET, POST, PUT, PATCH, DELETE
     *   - async: Whether the request is async
     *   - headers: Optional headers
     *
     * @returns {Observable} An observable sequence containing the XMLHttpRequest.
    */
    ajax.ajaxCold = function (settings) {
        return observableCreateWithDisposable( function (observer) {
            var isDone = false;
            if (typeof settings === 'string') {
                settings = { method: 'GET', url: settings, async: true };
            }
            settings.method || (settings.method = 'GET');
            if (settings.async === undefined) {
                settings.async = true;
            }

            var xhr;
            try {
                xhr = getXMLHttpRequest();
            } catch (err) {
                observer.onError(err);
            }

            try {
                if (settings.user) {
                    xhr.open(settings.method, settings.url, settings.async, settings.user, settings.password);
                } else {
                    xhr.open(settings.method, settings.url, settings.async);
                }

                if (settings.headers) {
                    var headers = settings.headers;
                    for (var header in headers) {
                        if (hasOwnProperty.call(headers, header)) {
                            xhr.setRequestHeader(header, headers[header]);
                        }
                    }
                }

                xhr.onreadystatechange = xhr.onload = function () {
                    if (xhr.readyState === 4) {
                        var status = xhr.status;
                        if ((status >= 200 && status <= 300) || status === 0 || status === '') {
                            observer.onNext(xhr);
                            observer.onCompleted();
                        } else {
                            observer.onError(xhr);
                        }

                        isDone = true;
                    }
                };

                xhr.onerror = function () {
                    observer.onError(xhr);
                };

                xhr.send(settings.body || null);
            } catch (e) {
                observer.onError(e);
            }
        
            return disposableCreate( function () {
                if (!isDone && xhr.readyState !== 4) {
                    xhr.abort();
                }
            });
        });
    };

    /** @private */
    var ajaxCold = ajax.ajaxCold;

    /**
     * Creates a hot observable for an Ajax request with either a settings object with url, headers, etc or a string for a URL.
     *
     * @example 
     *   source = Rx.DOM.Request.ajax('/products');
     *   source = Rx.DOM.Request.ajax( url: 'products', method: 'GET' });
     *
     * @param {Object} settings Can be one of the following:
     *
     *  A string of the URL to make the Ajax call.
     *  An object with the following properties
     *   - url: URL of the request
     *   - method: Method of the request, such as GET, POST, PUT, PATCH, DELETE
     *   - async: Whether the request is async
     *   - headers: Optional headers
     *
     * @returns {Observable} An observable sequence containing the XMLHttpRequest.
    */
    var observableAjax = ajax.ajax = function (settings) {
        return ajaxCold(settings).publishLast().refCount();
    };

    /**
     * Creates a cold observable sequence from an Ajax POST Request with the body.
     *
     * @param {String} url The URL to POST
     * @param {Object} body The body to POST
     * @returns {Observable} The observable sequence which contains the response from the Ajax POST.
     */
    ajax.postCold = function (url, body) {
        return observableAjax({ url: url, body: body, method: 'POST', async: true });
    };

    /**
     * Creates a hot observable sequence from an Ajax POST Request with the body.
     *
     * @param {String} url The URL to POST
     * @param {Object} body The body to POST
     * @returns {Observable} The observable sequence which contains the response from the Ajax POST.
     */
    ajax.post = function (url, body) {
        return observableAjax({ url: url, body: body, method: 'POST', async: true });
    };
    
    /**
     * Creates an observable sequence from an Ajax GET Request with the body.
     *
     * @param {String} url The URL to GET
     * @returns {Observable} The observable sequence which contains the response from the Ajax GET.
     */   
    var observableGet = ajax.get = function (url) {
        return observableAjax({ url: url, method: 'GET', async: true });
    };

    /**
     * Creates an observable sequence from an Ajax GET Request with the body.
     *
     * @param {String} url The URL to GET
     * @returns {Observable} The observable sequence which contains the response from the Ajax GET.
     */   
    var observableGetCold = ajax.getCold = function (url) {
        return observableAjax({ url: url, method: 'GET', async: true });
    };    
    
    if (typeof JSON !== 'undefined' && typeof JSON.parse === 'function') {
        /**
         * Creates an observable sequence from JSON from an Ajax request
         *
         * @param {String} url The URL to GET
         * @returns {Observable} The observable sequence which contains the parsed JSON.
         */       
        ajax.getJSON = function (url) {
            return observableGet(url).select(function (xhr) {
                return JSON.parse(xhr.responseText);
            });
        };

        /**
         * Creates an observable sequence from JSON from an Ajax request
         *
         * @param {String} url The URL to GET
         * @returns {Observable} The observable sequence which contains the parsed JSON.
         */       
        ajax.getJSONCold = function (url) {
            return observableGetCold(url).select(function (xhr) {
                return JSON.parse(xhr.responseText);
            });
        };            
    }    

    /** @private
     * Destroys the current element
     */
    var destroy = (function () {
        var trash = document.createElement('div');
        return function (element) {
            trash.appendChild(element);
            trash.innerHTML = '';
        };
    })();

    /**
     * Creates a cold observable JSONP Request with the specified settings.
     *
     * @example 
     *   source = Rx.DOM.Request.jsonpRequestCold('http://www.bing.com/?q=foo&JSONPRequest=?');
     *   source = Rx.DOM.Request.jsonpRequestCold( url: 'http://bing.com/?q=foo', jsonp: 'JSONPRequest' });
     *
     * @param {Object} settings Can be one of the following:
     *
     *  A string of the URL to make the JSONP call with the JSONPCallback=? in the url.
     *  An object with the following properties
     *   - url: URL of the request
     *   - jsonp: The named callback parameter for the JSONP call
     *
     * @returns {Observable} A cold observable containing the results from the JSONP call.
     */
    ajax.jsonpRequestCold = (function () {
        var uniqueId = 0;
        return function (settings) {
            return Observable.createWithDisposable(function (observer) {

                if (typeof settings === 'string') {
                    settings = { url: settings }
                }
                if (!settings.jsonp) {
                    settings.jsonp = 'JSONPCallback';
                }

                var head = document.getElementsByTagName('head')[0] || document.documentElement,
                    tag = document.createElement('script'),
                    handler = 'rxjscallback' + uniqueId++;

                settings.url = settings.url.replace('=' + settings.jsonp, '=' + handler);

                window[handler] = function (data) {
                    observer.onNext(data);
                    observer.onCompleted();  
                };

                tag.src = settings.url;
                tag.async = true;
                tag.onload = tag.onreadystatechange = function (_, abort) {
                    if ( abort || !tag.readyState || /loaded|complete/.test(tag.readyState) ) {
                        tag.onload = tag.onreadystatechange = null;
                        if (head && tag.parentNode) {
                            destroy(tag);
                        }
                        tag = undefined;
                        window[handler] = undefined;
                    }
                    
                };  
                head.insertBefore(tag, head.firstChild);

                return disposableCreate(function () {
                    if (!tag) {
                        return;
                    }
                    tag.onload = tag.onreadystatechange = null;
                    if (head && tag.parentNode) {
                        destroy(tag);
                    }
                    tag = undefined;
                    window[handler] = undefined;
                });
            });
        };      

    })();

    /** @private */
    var getJSONPRequestCold = ajax.jsonpRequestCold;

    /**
     * Creates a hot observable JSONP Request with the specified settings.
     *
     * @example 
     *   source = Rx.DOM.Request.getJSONPRequest('http://www.bing.com/?q=foo&JSONPRequest=?');
     *   source = Rx.DOM.Request.getJSONPRequest( url: 'http://bing.com/?q=foo', jsonp: 'JSONPRequest' });
     * 
     * @param {Object} settings Can be one of the following:
     *
     *  A string of the URL to make the JSONP call with the JSONPCallback=? in the url.
     *  An object with the following properties
     *   - url: URL of the request
     *   - jsonp: The named callback parameter for the JSONP call
     *
     * @returns {Observable} A hot observable containing the results from the JSONP call.
     */
    ajax.jsonpRequest = function (settings) {
        return getJSONPRequestCold(settings).publishLast().refCount();
    };
    if (window.WebSocket) {
         /**
         * Creates a WebSocket Subject with a given URL, protocol and an optional observer for the open event.
         * 
         * @example
         *  var socket = Rx.DOM.fromWebSocket('http://localhost:8080', 'stock-protocol', function(e) { ... });
         *  var socket = Rx.DOM.fromWebSocket('http://localhost:8080', 'stock-protocol', observer);
         *s
         * @param {String} url The URL of the WebSocket.
         * @param {String} protocol The protocol of the WebSocket.
         * @param {Function|Observer} [observerOrOnNext] An optional Observer or onNext function to capture the open event.
         * @returns {Subject} An observable sequence wrapping a WebSocket.
         */
        dom.fromWebSocket = function (url, protocol, observerOrOnNext) {
            var socket = new window.WebSocket(url, protocol);

            var observable = observableCreate(function (obs) {
                if (observerOrOnNext) {
                    socket.onopen = function (openEvent) {
                        if (typeof observerOrOnNext === 'function') {
                            observerOrOnNext(openEvent);
                        } else if (observerOrOnNext.onNext) {
                            observerOrOnNext.onNext(openEvent);
                        }
                    };
                }

                socket.onmessage = function (data) {
                    obs.onNext(data);
                };

                socket.onerror = function (err) {
                    obs.onError(err);
                };

                socket.onclose = function () {
                    obs.onCompleted();
                };

                return function () {
                    socket.close();
                };
            });

            var observer = observerCreate(function (data) {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(data);
                }
            });

            return Subject.create(observer, observable);
        };       
    }


    if (window.Worker) {
        /**
         * Creates a Web Worker with a given URL as a Subject.
         * 
         * @example
         * var worker = Rx.DOM.fromWebWorker('worker.js');
         *
         * @param {String} url The URL of the Web Worker.
         * @returns {Subject} A Subject wrapping the Web Worker.
         */
        dom.fromWebWorker = function (url) {
            var worker = new window.Worker(url);

            var observable = observableCreateWithDisposable(function (obs) {
                worker.onmessage = function (data) {
                    obs.onNext(data);
                };

                worker.onerror = function (err) {
                    obs.onError(err);
                };

                return disposableCreate(function () {
                    worker.close();
                });
            });

            var observer = observerCreate(function (data) {
                worker.postMessage(data);
            });

            return Subject.create(observer, observable);
        };      
    }

    if (window.MutationObserver) {

        /**
         * Creates an observable sequence from a Mutation Observer.
         * MutationObserver provides developers a way to react to changes in a DOM.
         * @example
         *  Rx.DOM.fromMutationObserver(document.getElementById('foo'), { attributes: true, childList: true, characterData: true });
         *
         * @param {Object} target The Node on which to obserave DOM mutations.
         * @param {Object} options A MutationObserverInit object, specifies which DOM mutations should be reported.
         * @returns {Observable} An observable sequence which contains mutations on the given DOM target.
         */
        dom.fromMutationObserver = function (target, options) {

            return observableCreate(function (observer) {
                var mutationObserver = new MutationObserver(function (mutations) {
                    observer.onNext(mutations);
                });

                mutationObserver.observe(target, options);

                return function () {
                    mutationObserver.disconnect();
                };
            });

        };

    }

    // Get the right animation frame method
    var requestAnimFrame, cancelAnimFrame;
    if (window.requestAnimationFrame) {
        requestAnimFrame = window.requestAnimationFrame;
        cancelAnimFrame = window.cancelAnimationFrame;
    } else if (window.mozRequestAnimationFrame) {
        requestAnimFrame = window.mozRequestAnimationFrame;
        cancelAnimFrame = window.mozCancelAnimationFrame;
    } else if (window.webkitRequestAnimationFrame) {
        requestAnimFrame = window.webkitRequestAnimationFrame;
        cancelAnimFrame = window.webkitCancelAnimationFrame;
    } else if (window.msRequestAnimationFrame) {
        requestAnimFrame = window.msRequestAnimationFrame;
        cancelAnimFrame = window.msCancelAnimationFrame;
    } else if (window.oRequestAnimationFrame) {
        requestAnimFrame = window.oRequestAnimationFrame;
        cancelAnimFrame = window.oCancelAnimationFrame;    
    } else {
        requestAnimFrame = function(cb) { window.setTimeout(cb, 1000 / 60); };
        cancelAnimFrame = window.clearTimeout;
    }

    /** 
     * Gets a scheduler that schedules schedules work on the requestAnimationFrame for immediate actions.
     *
     * @memberOf Scheduler
     */
    Scheduler.requestAnimationFrame = (function () {

        function scheduleNow(state, action) {
            var scheduler = this,
                disposable = new SingleAssignmentDisposable();
            var id = requestAnimFrame(function () {
                if (!disposable.isDisposed) {
                    disposable.setDisposable(action(scheduler, state));
                }
            });
            return new CompositeDisposable(disposable, disposableCreate(function () {
                cancelAnimFrame(id);
            }));
        }

        function scheduleRelative(state, dueTime, action) {
            var scheduler = this,
                dt = Scheduler.normalize(dueTime);
            if (dt === 0) {
                return scheduler.scheduleWithState(state, action);
            }

            var disposable = new SingleAssignmentDisposable(),
                id;
            var scheduleFunc = function () {
                if (id) { cancelAnimFrame(id); }
                if (dt - scheduler.now() <= 0) {
                    if (!disposable.isDisposed) {
                        disposable.setDisposable(action(scheduler, state));
                    }
                } else {
                    id = requestAnimFrame(scheduleFunc);
                }
            };

            id = requestAnimFrame(scheduleFunc);

            return new CompositeDisposable(disposable, disposableCreate(function () {
                cancelAnimFrame(id);
            }));
        }

        function scheduleAbsolute(state, dueTime, action) {
            return this.scheduleWithRelativeAndState(state, dueTime - this.now(), action);
        }

        return new Scheduler(defaultNow, scheduleNow, scheduleRelative, scheduleAbsolute);        

    }());
    
    // Check for mutation observer
    var BrowserMutationObserver = window.MutationObserver || window.WebKitMutationObserver;
    if (BrowserMutationObserver) {

        /**
         * Scheduler that uses a MutationObserver changes as the scheduling mechanism
         * @memberOf {Scheduler}
         */
        Scheduler.mutationObserver = (function () {

            var queue = {}, queueId = 0;

            function cloneObj (obj) {
                var newObj = {};
                for (var prop in obj) {
                    if (obj.hasOwnProperty(prop)) {
                        newObj[prop] = obj[prop];
                    }
                }
                return newObj;
            }

            var observer = new BrowserMutationObserver(function() {
                var toProcess = cloneObj(queue);
                queue = {};

                for (var prop in toProcess) {
                    if (toProcess.hasOwnProperty(prop)) {
                        toProcess[prop]();
                    }
                }
            });

            var element = document.createElement('div');
            observer.observe(element, { attributes: true });

            // Prevent leaks
            window.addEventListener('unload', function () {
                observer.disconnect();
                observer = null;
            }, false);

            function scheduleMethod (action) {
                var id = queueId++;
                queue[id] = action;
                element.setAttribute('drainQueue', 'drainQueue');
                return id;
            }

            function cancelMethod (id) {
                delete queue[id];
            }

            function scheduleNow(state, action) {
                var scheduler = this,
                    disposable = new SingleAssignmentDisposable();
                var id = scheduleMethod(function () {
                    if (!disposable.isDisposed) {
                        disposable.setDisposable(action(scheduler, state));
                    }
                });
                return disposable;
            }

            function scheduleRelative(state, dueTime, action) {
                var scheduler = this,
                    dt = Scheduler.normalize(dueTime);
                if (dt === 0) {
                    return scheduler.scheduleWithState(state, action);
                }

                var disposable = new SingleAssignmentDisposable(),
                    id;
                var scheduleFunc = function () {
                    if (id) { cancelMethod(id); }
                    if (dt - scheduler.now() <= 0) {
                        if (!disposable.isDisposed) {
                            disposable.setDisposable(action(scheduler, state));
                        }
                    } else {
                        id = scheduleMethod(scheduleFunc);
                    }
                };

                id = scheduleMethod(scheduleFunc);

                return new CompositeDisposable(disposable, disposableCreate(function () {
                    cancelMethod(id);
                }));
            }

            function scheduleAbsolute(state, dueTime, action) {
                return this.scheduleWithRelativeAndState(state, dueTime - this.now(), action);
            }

            return new Scheduler(defaultNow, scheduleNow, scheduleRelative, scheduleAbsolute);  
        }());
    }


    if ('navigator' in window && 'geolocation' in window.navigator) {
        Rx.DOM.Geolocation = {

            /**
             * Obtains the geographic position, in terms of latitude and longitude coordinates, of the device.
            * @param {Object} [geolocationOptions] An object literal to specify one or more of the following attributes and desired values:
            *   - enableHighAccuracy: Specify true to obtain the most accurate position possible, or false to optimize in favor of performance and power consumption.
            *   - timeout: An Integer value that indicates the time, in milliseconds, allowed for obtaining the position.
            *              If timeout is Infinity, (the default value) the location request will not time out.
            *              If timeout is zero (0) or negative, the results depend on the behavior of the location provider.
            *   - maximumAge: An Integer value indicating the maximum age, in milliseconds, of cached position information.
            *                 If maximumAge is non-zero, and a cached position that is no older than maximumAge is available, the cached position is used instead of obtaining an updated location.
            *                 If maximumAge is zero (0), watchPosition always tries to obtain an updated position, even if a cached position is already available.
            *                 If maximumAge is Infinity, any cached position is used, regardless of its age, and watchPosition only tries to obtain an updated position if no cached position data exists.
            * @returns {AsyncSubject} An observable sequence with the geographical location of the device running the client.
            */
            getCurrentPosition: function (geolocationOptions) {
                var subject = new Rx.AsyncSubject();

                window.navigator.geolocation.getCurrentPosition(
                    function successHandler (loc) {
                        subject.onNext(loc);
                        subject.onCompleted();                    
                    }, 
                    function errorHandler (err) {
                        subject.onError(err);
                    }, 
                    geolocationOptions);

                return subject.asObservable();
            },

            /**
            * Begins listening for updates to the current geographical location of the device running the client.
            * @param {Object} [geolocationOptions] An object literal to specify one or more of the following attributes and desired values:
            *   - enableHighAccuracy: Specify true to obtain the most accurate position possible, or false to optimize in favor of performance and power consumption.
            *   - timeout: An Integer value that indicates the time, in milliseconds, allowed for obtaining the position.
            *              If timeout is Infinity, (the default value) the location request will not time out.
            *              If timeout is zero (0) or negative, the results depend on the behavior of the location provider.
            *   - maximumAge: An Integer value indicating the maximum age, in milliseconds, of cached position information.
            *                 If maximumAge is non-zero, and a cached position that is no older than maximumAge is available, the cached position is used instead of obtaining an updated location.
            *                 If maximumAge is zero (0), watchPosition always tries to obtain an updated position, even if a cached position is already available.
            *                 If maximumAge is Infinity, any cached position is used, regardless of its age, and watchPosition only tries to obtain an updated position if no cached position data exists.
            * @returns {Observable} An observable sequence with the current geographical location of the device running the client.
            */ 
            watchPosition: function (geolocationOptions) {
                return observableCreate(function (observer) {
                    var watchId = window.navigator.geolocation.watchPosition(
                        function successHandler (loc) {
                            observer.onNext(loc);
                        }, 
                        function errorHandler (err) {
                            observer.onError(err);
                        }, 
                        geolocationOptions);

                    return function () {
                        window.navigator.geolocation.clearWatch(watchId);
                    };
                }).publish().refCount();
            }
        }
    }

    return Rx;
}));