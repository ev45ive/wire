//
// TODO:
// - Plugins for afterConstruct/beforeProperties, afterProperties/beforeInit, afterInit.
// - Plugin infrastructure for loading modules (how to bootstrap??), resolving references,
//    and setting properties
//    - Plugins should be simple to write, maybe just an AMD module that returns a function or hash of functions?
//    - Object processor plugins that get a chance to handle an object at various points in its lifecycle?  such as
//       just after: load, creation, prop setting, init?
// - Allow easier loading of modules that don't actually need to be references, like dijits that
//    might be used for data-dojo-type
// - It's easy to forget the "create" property which triggers calling a module as a constructor.  Need better syntax, or
//    maybe create should be the default?
// 
var wire = (function(){

	var VERSION = "0.1",
		tos = Object.prototype.toString,
		arrt = '[object Array]',
		uniqueNameCount = 0, // used to generate unique names
		d = document,
		undef;

	/*
		Function: uniqueName
		Generates a unique name.  The unique name will contain seed, if provided.
		
		Parameters:
			seed - (optional) If provided, the returned name will contain the String seed.
			
		Returns:
			A unique String name
	*/
	function uniqueName(seed) {
		return '_' + (seed ? seed : 'instance') + uniqueNameCount++;
	}

	function isArray(it) {
		return tos.call(it) === arrt;
	}

	function timer() {
		var start = new Date().getTime();
		return function() {
			return new Date().getTime() - start;
		};
	}
	
	function isModule(spec) {
		return spec.module;
	}
	
	function isRef(spec) {
		return spec && spec.$ref !== undef;
	}
	
	/*
		Function: collectModules
		Recursively collects all the AMD modules to be loaded before wiring the spec
		
		Parameters:
			spec - wiring spec
			
		Returns:
			Array of AMD module identifiers
	*/
	function collectModules(spec) {
		return collectModulesFromObject(spec, [], {});
	}

	function collectModulesFromObject(spec, modules, uniqueModuleNames) {
		if(isArray(spec)) {
			collectModulesFromArray(spec, modules, uniqueModuleNames);
			
		} else if(typeof spec == 'object') {

			if(isModule(spec)) {
				// For tidiness, ensure that we only put each module id into the modules array
				// once.  Loaders should handle it ok if they *do* appear more than once, imho, but
				// I've seen requirejs hit an infinite loop in that case, so better to be tidy here.
				if(!(spec.module in uniqueModuleNames)) {
					modules.push(spec.module);
					uniqueModuleNames[spec.module] = 1;
				}

				if(spec.properties) {
					collectModulesFromObject(spec.properties, modules, uniqueModuleNames);
				} else if (spec.create) {
					collectModulesFromObject(spec.args, modules, uniqueModuleNames);
				}

			} else {
				for(var prop in spec) {
					collectModulesFromObject(spec[prop], modules, uniqueModuleNames);
				}
			}
		}

		return modules;
	}

	function collectModulesFromArray(arr, modules, uniqueModuleNames) {
		for (var i = arr.length - 1; i >= 0; i--){
			collectModulesFromObject(arr[i], modules, uniqueModuleNames);
		}
	}	

	function loadModules(moduleNames, callback) {
		// TODO: Plugins for loading/resolving modules?
		require(moduleNames, callback);
	}
	
	function getLoadedModule(name) {
		// TODO: Plugins for loading/resolving modules?
		return require(name);
	}

	var Factory = function Factory(ctor, args) {
			return ctor.apply(this, args);
		};

	function instantiate(ctor, args) {
		Factory.prototype = ctor.prototype;
		Factory.prototype.constructor = ctor;
		return new Factory(ctor, args);
	}
	
	/*
		Function: createContext
		Creates a new Context with the supplied base Context.
		
		Parameters:
			spec - wiring spec
			modules - AMD module names loaded in this Context
			base - base (parent) Context.  Objects in the base are available
				to this Context.
	*/
	function createContext(spec, moduleNames, modules, base) {
		var context = {
			base: base,
			modules: moduleNames,
			/*
				Function: wire
				Wires a new, child of this Context, and passes it to the supplied
				ready callback, if provided

				Parameters:
					spec - wiring spec
					ready - Function to call with the newly wired child Context
			*/
			wire: function(spec, ready) {
				wireContext(spec, this, ready);
			}
		};
		
		return (function wireContext(context) {
			// TODO: There just has to be a better way to do this and keep
			// the objects hash private.
			var objects = {},
				plugins = registerPlugins(modules || []),
				objectInitQueue = [],
				refCache = {};
				
			function constructWithFactory(spec, name) {
				var module = getLoadedModule(name);
				if(!module) {
					throw Error("ERROR: no module loaded with name: " + name);
				}

				var func = spec.create.name,
					args = spec.create.args ? createObjects(spec.create.args) : [];

				return module[func].apply(module, args);
			}

			/*
				Function: constructWithNew
				Invokes the supplied constructor to create a new object
				
				Parameters:
					spec - The wiring spec of the object to be constructed containing
						parameters to be passed to the constructor.
					ctor - The constructor function to be invoked.
					
				Returns:
					The newly constructed object
			*/
			function constructWithNew(spec, ctor) {
				return spec.create ? instantiate(ctor, createObjects(spec.create)) : new ctor();
			}

			/*
				Function: setProperties
				Sets the supplied properties on the supplied target object.  This function attempts to
				use registered setter plugins, but if none succeed, falls back to standard Javascript
				property setting, e.g. target[prop] = value.
				
				Parameters:
					target - Object on which to set properties
					properties - Hash of properties to set, may contain references, wiring specs, etc.
				
			*/
			function setProperties(target, properties) {
				var setters = plugins.setters,
					cachedSetter;
				for(var p in properties) {
					var success = false,
						value = resolveObject(properties[p]);
						// value = initObject(properties[p], p);

					if(cachedSetter) {
						// If we previously found a working setter for this target, use it
						success = cachedSetter(target, p, value);
					}
					
					// If no cachedSetter, or cachedSetter failed, try all setters
					if(!success) {
						// Try all the registered setters until we find one that reports success
						for(var i = 0; i < setters.length && !success; i++) {
							success = setters[i](target, p, value);
							if(success) {
								cachedSetter = setters[i];
								break;
							}
						}
					}
					
					// If we still haven't succeeded, fall back to plain property value
					if(!success) {
						cachedSetter = function(target, prop, value) {
							target[prop] = value;
						};
						cachedSetter(target, p, value);
					}
				}
			}

			function processFuncList(list, target, callback) {
				var func;
				if(typeof list == "string") {
					// console.log("calling " + list + "()");
					func = target[list];
					if(typeof func == "function") {
						callback(target, func, []);
					}
				} else {
					for(var f in list) {
						// console.log("calling " + f + "(" + list[f] + ")");
						func = target[f];
						if(typeof func == "function") {
							callback(target, func, list[f]);
						}
					}
				}
			}

			function callInit(target, func, args) {
				// Resolve all the args
				var resolvedArgs = [];
				if(isArray(args)) {
					for(var i=0; i<args.length; i++) {
						resolvedArgs.push(resolveObject(args[i]));
					}
				} else {
					resolvedArgs[0] = resolveObject(args);
				}
				
				func.apply(target, resolvedArgs);
			}

			function addReadyInit(target, func, args) {
				require.ready(function() {
					callInit(target, func, args);
				});
			}

			/*
				Function: constructContext
				Fully constructs and initializes all objects, and resolves all references in the supplied
				wiring spec.
				
				Parameters:
					spec - wiring spec
			*/
			function constructContext(spec) {
				for(var prop in spec) {
					createObjects(spec[prop], prop);
				}

				for(var i=0; i<objectInitQueue.length; i++) {
					objectInitQueue[i]();
				}
			}
			
			function createObjects(spec, name) {
				// By default, just return the spec if it's not an object or array
				var result = spec;

				// If spec is an object or array, process it
				if(isArray(spec)) {
					// If it's an array, createObjects() each element
					result = [];
					for (var i=0; i < spec.length; i++) {
						result.push(createObjects(spec[i]));
					}

				} else if(typeof spec == 'object') {
					// If it's a module
					//  - if it has a create function, call it, with args and set result
					//  - if no factory function, invoke new as constructor and set result
					//  - if init function, invoke after factory or constructor
					// If it's a reference
					//  - resolve the reference directly, no recursive construction
					// If it's not a module
					//  - recursive createObjects() and set result
					if(isModule(spec)) {
						name = name || spec.name;
						result = getLoadedModule(spec.module);
						if(!result) {
							throw new Error("No module loaded with name: " + name);
						}
						
						if(spec.create) {
							// TODO: Handle calling a factory method and using the return value as result?
							// See constructWithFactory()
							// console.log('constructing ' + name + " from " + spec.module);
							result = constructWithNew(spec, result);
						}
						
						// Cache the actual object
						spec._ = result;
						
						if(spec.properties) createObjects(spec.properties);
						if(spec.init) createObjects(spec.init);
						
					} else if (isRef(spec)) {
						result = resolveName(spec.$ref);
						
					} else {
						// Recursively create sub-objects
						result = {};
						for(var prop in spec) {
							result[prop] = createObjects(spec[prop], prop);
						}
						
					}

					// Queue a function to initialize the object later, after all
					// objects have been created
					objectInitQueue.push(function() {
						if(!isRef(spec)) plugins.callAfterPlugins('afterCreate', result, spec, resolveName);
						initObject(spec, name);
					});
				}

				return result;
			}
			
			function initObject(spec, name) {
				var result = spec;
				
				if(typeof spec._ == 'object') {
					result = spec._;
					if(spec.properties && typeof spec.properties == 'object') {
						// console.log("setting props on " + spec.name);
						setProperties(result, spec.properties);
						plugins.callAfterPlugins('afterProperties', result, spec, resolveName);
					}
					
					// If it has init functions, call it
					if(spec.init) {
						processFuncList(spec.init, result, addReadyInit);
						plugins.callAfterPlugins('afterInit', result, spec, resolveName);
					}
				} else if (isRef(spec)) {
					result = resolveName(spec.$ref);

				} else {
					result = {};
					for(var prop in spec) {
						result[prop] = resolveObject(spec[prop]);
					}
					
				}
				
				return result;
			}
			
			function resolveObject(refObj) {
				return isRef(refObj) ? resolveName(refObj.$ref) : getObject(refObj);
			}
			
			function resolveName(ref) {
				var resolved,
					resolvers = plugins.resolvers;
				if(ref in refCache) {
					resolved = refCache[ref];
					
				} else {
					if(ref.indexOf("!") == -1) {
						resolved = (ref in spec) ? getObject(spec[ref]) : undef;

					} else {
						var parts = ref.split("!");

						if(parts.length == 2) {
							var prefix = parts[0];

							if(prefix in resolvers) {
								var name = parts[1];
								resolved = resolvers[prefix](name, context);
							}
						}

					}

					if(resolved === undef) {
						resolved = (base && base.get(ref)) || undef;
					}
					
					if(isRef(resolved)) {
						throw new Error("Recursive $refs not allowed: $ref " + ref + " refers to $ref " + resolved.$ref);

					} else if(resolved === undef) {
						throw new Error("Reference " + ref + " cannot be resolved");
						
					} else {
						// Cache the resolved reference
						refCache[ref] = resolved;
					}
				}
				
				return getObject(resolved);
			}

			function getObject(spec) {
				return spec._ || spec;
			}
			
			context.get = resolveName;

			constructContext(spec);

			return context;
		})(context);
	}
	
	/*
		Function: registerPlugins
		Inspects all modules for plugins and registers any it finds
		
		Parameters:
			modules - Array of loaded modules
			
		Returns:
			Registered plugins
	*/
	function registerPlugins(modules) {
		var plugins = {
			resolvers: {},
			setters: [],
			afterCreate: [],
			afterProperties: [],
			afterInit: [],
			callAfterPlugins: function(name, target, spec, resolver) {
				var pluginsToCall = plugins[name];
				for(var i=0; i<pluginsToCall.length; i++) {
					pluginsToCall[i](target, spec, resolver);
				}
			}
		};
		
		for (var i=0; i < modules.length; i++) {
			var newPlugin = modules[i];
			// console.log("scanning for plugins: " + newPlugin);
			if(newPlugin.wire$resolvers) {
				for(var name in newPlugin.wire$resolvers) {
					// console.log("resolver plugin: " + name);
					plugins.resolvers[name] = newPlugin.wire$resolvers[name];
				}
			}
			
			if(newPlugin.wire$setters) {
				plugins.setters = plugins.setters.concat(newPlugin.wire$setters);
			}
			
			if(typeof newPlugin.wire$init == 'function') {
				// Have to init plugins immediately, so they can be used during wiring
				newPlugin.wire$init();
			}
			
			var afters = ['afterCreate', 'afterProperties', 'afterInit'];
			for(var j = afters.length-1; j >= 0; --j) {
				var after = afters[j],
					wireAfter = newPlugin['wire$' + after];
				if(typeof wireAfter == 'function') {
					plugins[after].push(wireAfter);
				}
			}
		}
		
		return plugins;
	}
	
	/*
		Function: wireContext
		Does all the steps of parsing, module loading, object instantiation, and
		reference wiring necessary to create a new Context.
		
		Parameters:
			spec - wiring spec
			base - base (parent) Context.  Objects in the base are available
				to this Context.
			ready - Function to call with the newly wired Context
	*/
	function wireContext(spec, base, ready) {
		// 1. First pass, build module list for require, call require
		// 2. Second pass, depth first instantiate 

		var t = timer();

		// First pass
		var modules = collectModules(spec);
		console.log("modules scanned: " + t() + "ms");
		
		// Second pass happens after modules loaded
		loadModules(modules, function() {
			console.log("modules loaded: " + t() + "ms");
			
			// Second pass, construct context and object instances
			var context = createContext(spec, modules, arguments, base);
			
			console.log("total: " + t() + "ms");
			
			// Call callback when entire context is ready
			// TODO: Return a promise instead?
			if(ready) ready(context);
		});

	};
	
	/*
		Variable: rootContext
		The top-level root of all Contexts.
	*/
	var rootContext = createContext({}, []);

	/*
		Function: wire
		Global wire function that is the starting point for wiring applications.
		
		Parameters:
			spec - wiring spec
			ready - Function to call with the newly wired Context
	*/
	var w = function wire(spec, ready) {
		rootContext.wire(spec, ready);
	};
	
	w.version = VERSION;
	
	// WARNING: Probably unsafe. Just for testing right now.
	// TODO: Only do this for browser env
	var head = d.getElementsByTagName('head')[0],
		scripts = d.getElementsByTagName('script');
	for(var i=0; i<scripts.length; i++) {
		var script = scripts[i],
			src = script.src,
			specUrl;

		if(/wire\.js(\W|$)/.test(src) && (specUrl = script.getAttribute('data-wire-spec'))) {
			loadSpec(head, specUrl);
		}
	}

	function loadSpec(head, specUrl) {
		var script = document.createElement('script');
		script.src = specUrl;
		head.appendChild(script);
	}
	
	return w;
})();
