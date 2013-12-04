/*jslint sloppy: true, node: true, nomen: true */
/*global Future, log, Kinds, debug, DB, CalDav */

var DiscoveryAssistant = function () {};

//call with accountId (required), username, name, url.
//accountId, name and username will be used to search for config object.
//url will be updated in DB. If no object in DB, yet, URL is required.
DiscoveryAssistant.prototype.run = function (outerFuture) {
	var future = new Future(), args = this.controller.args;

	if (this.client && this.client.config) {
		future.nest(this.processAccount(args, this.client.config));
	} else {
		log("No config object was found by serviceAssistant! Trying to create new one with command line arguments.");
		future.nest(this.processAccount(args, {
			_kind: "org.webosports.service.contacts.carddav.account.config:1",
			accountId: args.accountId
		}));
	}

	future.then(this, function discoveryFinished() {
		var result = future.result || {returnValue: false};
		log("Discovery finished.");
		outerFuture.result = result;
	});
	return outerFuture;
};

DiscoveryAssistant.prototype.processAccount = function (args, config) {
	var future = new Future(), outerFuture = new Future(), params;

	if (config) {
		debug("Got config object: " + JSON.stringify(config));

		if (args.accountId) {
			config.accountId = args.accountId;
		}
		if (args.username) {
			config.username = args.username;
		}
		if (args.name) {
			config.name = args.name;
		}
		if (args.url) {
			config.url = args.url;
		}

		if (!config.url) {
			log("No url for " + JSON.stringify(config) + " found in db or agruments. Can't process this account.");
			outerFuture.result = {returnValue: false, success: false, msg: "No url for account in config."};
			return outerFuture;
		}

		params = {
			path: CalDav.setHostAndPort(config.url),
			authToken: this.client.userAuth.authToken,
			originalUrl: config.url
		};

		future.nest(CalDav.discovery(params));

		future.then(this, function discoverCB() {
			var result = future.result, i, f;

			if (result.returnValue === true) {
				config[Kinds.objects.calendarevent.name] = {
					homeFolder: result.calendarHome
				};
				config[Kinds.objects.contact.name] = {
					homeFolder: result.contactHome
				};
			} else {
				log("Could not discover addressbook and calendar folders: " + JSON.stringify(result));

				log("Setting home folders to original URL and hoping for the best.");
				config[Kinds.objects.calendarevent.name] = {
					homeFolder: config.url
				};
				config[Kinds.objects.contact.name] = {
					homeFolder: config.url
				};
			}

			future.nest(DB.merge([config]));
		});

		future.then(this, function storeConfigCB() {
			var result = future.result || future.exception;
			debug("Store config came back: " + JSON.stringify(result));
			outerFuture.result = {returnValue: result.returnValue, success: result.returnValue, config: config};
		});
	}

	return outerFuture;
};
