//JSLint things:
/*jslint nomen: true, continue: true */
/*global log, PalmCall, Calendar, decodeURIComponent, escape, unescape, encodeURIComponent, quoted_printable_decode, unquote, quote, Future, quoted_printable_encode, log_icalDebug, fold */

// This is a small iCal to webOs event parser.
// Its meant to be simple and has some deficiencies.
// It can only parse VCALENDAR objects with exactly one VEVENT in them.
// It ignores most of the parameter values, if they are not really necessary and won't set them.
// Currently its hardly tied to the needs of the SyncML implementation and an egroupware server.
// Many things might not be really tested.
// ParentId of exceptions to reccurring events is not really set. I try to set it for all events I have an id for.
// If and event has no id set and has exceptions, then an recurringId is set. If the event is an execption it has the parentLocalId set to the same
// id. That means, that the processing entity should fill the parentId in for this event.

//Known issues:
//Timezones... :(
//Easiest thing is: Server and Client are in same TS and server sends events in "right" tz. Or server nows tz of client and sends in the right tz.
//Ok is: Server sends dates as UTC (currently NOT working! :() To fix: Change to "date.UTC" in icaltowebos (and something similar in other function!)
//Quite impossible: Server sends dates in other TS than device is in... Don't know how to handle that, yet. :(

var iCal = (function () {
//  var e = { //structure of webOs events:
//      alarm                   : [ { //=VALARM
//        action              : "", //one or more of "audio", "display", "email"
//        alarmTrigger : { //only first one supported (from webpage.. don't really understand what that means.
//                         //Is this meant to be an array? or only for first alarm supported? or is only datetime supported?
//          value:         "", // "19981208T000000Z | (+/-) PT15M"
//          valueType: "DURATION"        // DATETIME | DURATION - should match the value. :) => in RFC this is DATE-TIME..?
//        },
//        attach       : "", //string => url / binary? => don't use. :) => not in RFC?
//        description  : "", //text of e-mail body or text description. Does webOs actually support this? I didn't see something like that, yet. => not in RFC?
//        duration     : "", //time between repeats => makes repeat required.
//        repeat       : 0,  //number of times to repeat. => makes duration required.
//        summary      : "", //subject for e-mail. => not in RFC?
//        trigger      : ""} ], //original trigger string vom iCal. => will be only stored. Hm.
//      allDay         : false, //all day has no time, only a date. TODO: check if that really is true.. we had severe problems with allDay and sync. :( => not in RFC => real problem!
//      attach         : [""], //attachment as uri.
//      attendees      : [{
//        calendarUserType    : "", //comma seperated list of "INDIVIDUAL", "GROUP", "RESOURCE", "ROOM", "UNKNOWN", "other"
//        commonName          : "", //name of attendee.
//        delegatedFrom       : "",
//        delegatedTo         : "",
//        dir                 : "", //LDAP or webadress - not checked.
//        email               : "",
//        language            : "", //not validated.
//        organizer           : false,
//        member              : string,
//        participationStatus : "", //Comma-separated list of "NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED", "other".
//        role                : "", //Comma-separated list of "CHAIR", "REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT", "other".
//        rsvp                : boolean,
//        sentBy              : string }],
//      calendarId     : "",
//      categories     : "",
//      classification : "", //RFC field. "PUBLIC" "PRIVATE" | "CONFIDENTIAL".
//      comment        : "",
//      contact        : "",
//      created        : 0,  //created time.
//      dtend          : 0,  //end time
//      dtstart        : 0,  //start time
//      dtstamp        : "", //object created.
//      exdates        : [""],
//      geo            : "", //lat/long coordinates listed as "float;float".
//      lastModified   : 0,  //lastModified
//      location       : "", //event location.
//      note           : "", //text content.
//      parentDtstart  : 0,  //quite complex to fill, see "tryToFillParentID"
//      parentId       : 0,  // same as parteDtstart
//      priority       : 0,  //0-9: 0=undefined, 1=high, 9=low
//      rdates         : [""],
//      recurrenceId   : "",
//      relatedTo      : "",
//      requestStatus  : "",
//      resources      : "",
//      rrule          : { },
//      sequence       : 0,  //kind of "version" of the event.
//      subject        : "", //event subject
//      transp         : "", //"OPAQUE" | "TRANSPARENT". Opaque if this event displays as busy on a calendar, transparent if it displays as free.
//      tzId           : "",
//      url            : ""
//  },
	"use strict";
	var dayToNum = { "SU": 0, "MO": 1, "TU": 2, "WE": 3, "TH": 4, "FR": 5, "SA": 6 },
		numToDay = { "0": "SU", "1": "MO", "2": "TU", "3": "WE", "4": "TH", "5": "FR", "6": "SA"},
		DATETIME = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(Z?)$/,
		DATE = /^(\d{4})(\d\d)(\d\d)$/,
		//DATE: yyyymmdd, time: hhmmss, if both are present they are divided by a T. A Z at the end is optional.
		//if only a Date is given (=> allDay), no letters are present and just 8 numbers should be given.
		//Usually the Z at the end of DATE-TIME should say that it's UTC. But I'm quite sure that most programs do this wrong... :(
		//there is a timezone property that could be set.
		//it could also be a comma seperated list of dates / date times. But we don't support that, yet.. ;)
		recurringEvents = [], //this is used to try to get parentIds. This will only work, if the recurring event is processed in the same session as the exception..
		//used to try timeZone correction...
		localTzId = "UTC",
		TZManager = Calendar.TimezoneManager(),
		shiftAllDay = true,
		calendarVersion = 2;

	function iCalTimeToWebOsTime(time, tz) {
		var t = {offset: 0}, result, date, offset, ts2;
		t.allDayCue = !DATETIME.test(time);
		if (!tz || !tz.tzId) {
			if (time.charAt(time.length - 1) === "Z") {
				tz = {tzId: "UTC"};
				t.tzId = "UTC";
			} else {
				tz = {tzId: localTzId};
				t.tzId = localTzId;
			}
		} else {
			t.tzId = tz.tzId;
		}
		if (t.allDayCue) {
			//only have DATE, add hours, minutes, and seconds
			result = DATE.exec(time);
			result.push(12); //use 12 here, so that time is in the middle of day and timezone changes, i.e. daylight saving times, won't spread all day events to multiple days.
			result.push(0);
			result.push(0);
		} else {
			//have date and time:
			result = DATETIME.exec(time);
		}
		//look at tzId. Shift whole thing that we have all day events on the right day, no matter the TZ.
		date = new Date(result[1], result[2] - 1, result[3], result[4], result[5], result[6]);
		t.offset = date.getTimezoneOffset() * 60000;
		if (localTzId === tz.tzId) {
			//for times in the local tz, this will be ok in any case.
			t.ts = date.getTime();
		} else if (tz.tzId === "UTC") { //got UTC time, we can easily correct that:
			t.ts = Date.UTC(result[1], result[2] - 1, result[3], result[4], result[5], result[6]); //get UTC timestamp from UTC date values :)
			if (t.allDayCue && shiftAllDay) { //move to 0:00 in local timeZone.
				t.ts += date.getTimezoneOffset() * 60000;
			}
		} else { //this relies on a framework function from webOs.
			ts2 = date.getTime();
			t.ts = TZManager.convertTime(ts2, t.tzId, localTzId);
			if (t.allDayCue && shiftAllDay) {
				offset = (t.ts - ts2) * 2;
				t.ts -= offset;
			}
		}
		return t;
	}

	function webOsTimeToICal(time, allDay, tzId, addTZIDParam) {
		var t = "", date, time2, offset;
		tzId = "UTC";	//we can't provide VTIMEZONE entries that are needed if a TZID parameter is set, so let's just transfer everything to UTC, it's the savest bet.
						//"Floating" time would be possible, too, but seems to be ignored by some servers (??)

		date = new Date(time);
		if (!tzId) {
			tzId = localTzId; //if nothing is specified, take "floating time" which means no timezone at all.
		}
		if (tzId === localTzId) {
			t = date.getFullYear() + (date.getMonth() + 1 < 10 ? "0" : "") + (date.getMonth() + 1) + (date.getDate() < 10 ? "0" : "") + date.getDate();
			if (!allDay) {
				t += "T" + (date.getHours() < 10 ? "0" : "") + date.getHours();
				t += (date.getMinutes() < 10 ? "0" : "") + date.getMinutes();
				t += (date.getSeconds() < 10 ? "0" : "") + date.getSeconds();
			}
		} else if (tzId === "UTC") {
			if (allDay && shiftAllDay) {
				t = date.getFullYear() + (date.getMonth() + 1 < 10 ? "0" : "") + (date.getMonth() + 1) + (date.getDate() < 10 ? "0" : "") + date.getDate();
				if (calendarVersion === 1) {
					t += "T000000";
				}
			} else {
				t = date.getUTCFullYear() + (date.getUTCMonth() + 1 < 10 ? "0" : "") + (date.getUTCMonth() + 1) + (date.getUTCDate() < 10 ? "0" : "") + date.getUTCDate();
				if (!allDay) {
					t += "T" + (date.getUTCHours() < 10 ? "0" : "") + date.getUTCHours();
					t += (date.getUTCMinutes() < 10 ? "0" : "") + date.getUTCMinutes();
					t += (date.getUTCSeconds() < 10 ? "0" : "") + date.getUTCSeconds();
					t += "Z"; //is a hint that time is in UTC.
				}
			}
		} else {
			time2 = TZManager.convertTime(time, localTzId, tzId); //convert local ts to target, now should be correct UTC TS, right?
			if (allDay && shiftAllDay) {
				offset = (time2 - time) * 2;
				time2 -= offset;
			}
			t = webOsTimeToICal(time2, allDay, localTzId, addTZIDParam);
		}
		return t;
	}

	function convertDurationIntoMicroseconds(duration) {
		var signRegExp = /^([+\-])?PT?([0-9DHM]+)/gi, parts, sign, remaining,
			weekRegExp = /(\d)+W/gi,
			dayRegExp = /(\d)+D/gi,
			hourRegExp = /(\d)+H/gi,
			minuteRegExp = /(\d)+M/gi,
			secondRegExp = /(\d)+S/gi,
			offset = 0;

		parts = signRegExp.exec(duration);
		if (parts) {
			sign = parts[1] === "-" ? -1 : 1;
			remaining = parts[2];

			parts = weekRegExp.exec(remaining);
			if (parts) {
				offset += parseInt(parts[1], 10) * 86400000 * 7;
			}

			parts = dayRegExp.exec(remaining);
			if (parts) {
				offset += parseInt(parts[1], 10) * 86400000;
			}

			parts = hourRegExp.exec(remaining);
			if (parts) {
				offset += parseInt(parts[1], 10) * 3600000;
			}

			parts = minuteRegExp.exec(remaining);
			if (parts) {
				offset += parseInt(parts[1], 10) * 60000;
			}

			parts = secondRegExp.exec(remaining);
			if (parts) {
				offset += parseInt(parts[1], 10) * 1000;
			}

			offset *= sign;
			log_icalDebug("Converted duration " + duration + " into offset " + offset);
			return offset;
		} else {
			log("iCal.js======> DURATION DID NOT MATCH: ", duration);
			return 0;
		}
	}

	function parseDATEARRAY(str) {
		var parts, times = [], i;
		parts = str.split(",");
		for (i = 0; i < parts.length; i += 1) {
			if (DATE.test(parts[i]) || DATETIME.test(parts[i])) { //skip empty / false values.
				times.push(parts[i]);
			}
		}
		return times;
	}

	//this is strange. This should correctly parse RFC things... even, from RFC, there should also only be numbers in BYDAY, not days.
	//days are only specified for wkst. But the samples from palm, which say that BYSETPOS is not defined (but it's used in their own
	//samples to explain the rrule object ????) use days for BYDAY...
	function parseRULEofRRULE(key, value) {
		var days, day, i, rule = { ruleType: key, ruleValue: []};
		days = value.split(",");
		for (i = 0; i < days.length; i += 1) {
			if (days[i].length >= 2) {
				day = days[i].substr(days[i].length - 2); //extract day of week
				day = dayToNum[day];
				if (day || day === 0) { //really was a day, as it seems. :) === 0 is necessary for sunday..
					rule.ruleValue.push({day: day, ord: days[i].substring(0, days[i].length - 2)});
				} else {
					rule.ruleValue.push({ord: days[i]});
				}
			} else {
				rule.ruleValue.push({ord: days[i]});
			}
		}
		return rule;
	}

	function buildRRULE(rr, tzId) {
		var text = "RRULE:", i, j, day;
		text += "FREQ=" + rr.freq + ";";
		if (rr.count) {
			text += "COUNT=" + rr.count + ";";
		}
		if (rr.interval && parseInt(rr.interval, 10) !== 1) {
			text += "INTERVAL=" + rr.interval + ";";
		}
		if (rr.until) {
			text += "UNTIL=" + webOsTimeToICal(rr.until, false, tzId) + ";";
		}
		if (rr.wkst || rr.wkst === 0 || rr.wkst === "0") {
			text += "WKST=" + numToDay(rr.wkst) + ";";
		}
		for (i = 0; rr.rules && i < rr.rules.length; i += 1) {
			text += rr.rules[i].ruleType + "=";
			for (j = 0; j < rr.rules[i].ruleValue.length; j += 1) {
				day = rr.rules[i].ruleValue[j];
				if (j !== 0) {
					text += ",";
				}
				if (day.ord || day.ord === 0) {
					text += day.ord;
				}
				if (day.day || day.day === 0) {
					if (rr.rules[i].ruleType === "BYDAY") {
						text += numToDay[day.day];
					} else {
						text += day.day;
					}
				}
			}
			text += ";";
		}
		//remove last ";".
		return text.substring(0, text.length - 1);
	}

	function buildRRULEvCalendar(rr, tzId) {
		var text, freqType, i, j, freqMod = [], sign = "+", ordFactor = 1, rule;
		for (i = 0; rr.rules && i < rr.rules.length; i += 1) {
			if (rr.rules[i].ruleType === "BYDAY") {
				freqType = "P";
			}
			for (j = 0; j < rr.rules[i].ruleValue.length; j += 1) {
				rule = rr.rules[i].ruleValue[j];
				if (rule.ord < 0) {
					sign = "-";
					ordFactor = -1;
				} else {
					sign = "+";
					ordFactor = 1;
				}
				freqMod[j] = "";
				if (rule.ord) {
					freqMod[j] += (ordFactor * rule.ord) + sign + " ";
				}
				if (rule.day) {
					freqMod[j] += numToDay[rule.day];
				}
			}
		}
		//select default values, if no byday rule was present:
		if (freqType === undefined) {
			if (rr.freq === "YEARLY") {
				freqType = "M";
			} else if (rr.freq === "MONTHLY") {
				freqType = "D";
			} else {
				freqType = "";
			}
		}
		text = "RRULE: " + rr.freq.charAt(0) + freqType + rr.interval; //only takes first char of freq.
		for (i = 0; i < freqMod.length; i += 1) {
			text += " " + freqMod[i];
		}
		if (rr.count) { //does this cause trouble? Was necessary for myFunambol to understand until clause. I think this is correct, isn't it?
			text += " #" + (rr.count || "0");
		}
		if (rr.until) {
			text += " " + webOsTimeToICal(rr.until, false, tzId);
		}
		return text;
	}

	function parseRRULEvCalendar(rs) {
		var rrule = { rules: []}, parts, transFreq = {"D": "DAILY", "W": "WEEKLY", "M": "MONTHLY", "Y": "YEARLY"},
			ruleType = "BYDAY",
			interVal = 1,
			needRules = true,
			part,
			day,
			partialRules = [],
			i,
			j,
			ord = /([0-9]+)([\-+]?)/,
			ordParts,
			ordNum,
			rule;
		parts = rs.split(" ");
		rrule.freq = transFreq[rs.charAt(0)]; //first char determines interval.
		if (!rrule.freq) { //if we could not read frequency, most probably other things are broken, too.
			log("Could not read frequency. Malformed RRULE string: " + rs);
			return undefined;
		}
		if (rs.charAt(1) === "D") {
			if (rrule.freq === "MONTHLY") {
				needRules = false; //have not seen sensible rules I can support for MD.
			}
			interVal = 2;
		} else if (rs.charAt(1) === "P") {
			needRules = true;
			interVal = 2;
		} else if (rs.charAt(1) === "M") {
			if (rrule.freq === "YEARLY") {
				needRules = false; //have not seen sensible rules I can support for YM.
			}
			interVal = 2;
		}
		rrule.interval = rs.charAt(interVal);
		rule = {ruleValue: [], ruleType: ruleType};
		for (i = 1; i < parts.length; i += 1) {
			part = parts[i];
			if (part.charAt(0) === "#") {
				//end of rule, rest is count (which is not supported by webos for some strange reason).
				rrule.count = part.substring(1);
			} else if (DATETIME.test(part)) { //found until.
				rrule.until = part; //will be transformed to Timestamp when everything else is finished.
			} else if (needRules) { //this is not count or until, might be a day or a number.
				day = dayToNum[part];
				if (day !== undefined) { //read a day. All ords before are belonging to this day.
					for (j = 0; j < partialRules.length; j += 1) {
						partialRules[j].day = day;
					}
					if (!partialRules.length) { //no ords, only day.
						rule.ruleValue.push({day: day});
					} else { //got ord and day values.
						rule.ruleValue = partialRules;
					}
					if (rrule.freq === "DAILY") { //can't really support daily repeats by week day, makes more sense for weekly anyways.
						rrule.freq = "WEEKLY";
					}
					partialRules = []; //empty ords
				} else { //did not get day, yet. Will be ord in form of NUMBER[+/-]
					ordParts = ord.exec(part);
					if (ordParts) {
						ordNum = parseInt(ordParts[0], 10);
						if (ordParts[1] === "-") {
							ordNum *= -1;
						}
						partialRules.push({ord: ordNum});
					} else {
						log("Something went wrong, could not interpret part " + part + " of rrule string " + rs);
					}
				}
			}
		}
		if (partialRules.length) { //did not have a day.
			rule.ruleValue = partialRules;
		}
		if (rule.ruleValue.length) {
			rrule.rules.push(rule);
		}
		if (!rrule.rules.length) {
			delete rrule.rules;
		}
		return rrule;
	}

	function parseRRULE(rs) {
		var rrule = {}, params, kv, i;
		params = rs.split(";");
		for (i = 0; i < params.length; i += 1) {
			kv = params[i].split("=");
			switch (kv[0]) {
			case "FREQ":
				rrule.freq = kv[1];
				break;
			case "COUNT":
				rrule.count = kv[1];
				break;
			case "UNTIL":
				rrule.until = kv[1]; //will be transformed to TS at the end of event processing to get TZID right.
				break;
			case "INTERVAL":
				rrule.interval = kv[1];
				break;
			case "WKST":
				rrule.wkst = dayToNum(kv[1]);
				break;
			case "BYDAY":
			case "BYMONTHDAY":
			case "BYYEARDAY":
			case "BYWEEKNO":
			case "BYMONTH":
				if (!rrule.rules) {
					rrule.rules = [];
				}
				rrule.rules.push(parseRULEofRRULE(kv[0], kv[1]));
				break;
			default:
				if (kv[0].charAt(0) !== "D" && kv[0].charAt(0) !== "W" && kv[0].charAt(0) !== "M" && kv[0].charAt(0) !== "Y") { //no complaint about vCalendar rules.
					log("rrule Parameter " + kv[0] + " not supported. Will skip " + params[i]);
				}
				break;
			}
		}
		if (!rrule.freq) {
			return parseRRULEvCalendar(rs);
		}
		return rrule;
	}

	function parseOneLine(line) {
		var lObj = { line: line, parameters: {} }, parts, parameters, paramParts, i;
		parts = line.split(":");
		lObj.value = parts[1]; //value is always after :.
		//: is allowed in the value part, add them again:
		for (i = 2; i < parts.length; i += 1) {
			lObj.value += ":" + parts[i]; //this should repair "mailTO:"... :)
		}
		//first part can contain parameters which are seperated from key and themselves with ;
		parameters = parts[0].split(";");
		lObj.key = parameters[0]; //now key is the first part of the parameters, allways.
		for (i = 1; i < parameters.length; i += 1) {
			//have a look at the rest of the parameters, they now have the form KEY=VALUE.
			paramParts = parameters[i].split("=");
			if (!lObj.parameters) {
				lObj.parameters = {};
			}
			lObj.parameters[paramParts[0].toLowerCase()] = paramParts[1];
		}
		return lObj;
	}

	function parseAlarm(lObj, alarm) {
		//webos does not support attendee here => e-Mail won't work. Don't care. Hopefully nothing crashes. ;)
		if (lObj.key === "TRIGGER") {
			//process trigger.
			alarm.trigger = lObj.line; //save complete trigger string.
			//TODO: try to repair some deficiencies of webOs here... for example related end could be easily repaired if dtend and dtstart are known.
			alarm.alarmTrigger = { value: lObj.value, valueType: lObj.parameters.value || "DURATION" }; //decode string a bit for webOs.
			if (alarm.alarmTrigger.value === "P" || alarm.alarmTrigger.value === "-P") { //fix issue in webOS 2.1.1 with alarm 0 min before start.
				alarm.alarmTrigger.value = "-PT0M";
			}

			if (alarm.alarmTrigger.valueType === "DATE-TIME") {
				//docs say webos wants "DATETIME" not "DATE-TIME" like iCal... :(
				alarm.alarmTrigger.valueType = "DATETIME";
			}
			//log_icalDebug("Parsed trigger " + lObj.line + " to " + JSON.stringify(alarm.alarmTrigger));
		} else if (lObj.key === "END") {
			if (lObj.value !== "VALARM") {
				throw ({name: "SyntaxError", message: "BEGIN:VALARM was not followed by END:VALARM. Something is very wrong here."});
			}
			//log_icalDebug("Build alarm: " + JSON.stringify(alarm));
			return undefined;
		} else {
			alarm[lObj.key.toLowerCase()] = lObj.value;
		}
		return alarm;
	}

	function parseDaylightStandard(lObj, obj) {
		switch (lObj.key) {
		case "TZOFFSETTO":
			obj.offset = parseInt(lObj.value, 10) / 100;
			break;
		case "RRULE":
			obj.rrule = parseRRULE(lObj.value);
			break;
		case "END":
			delete obj.mode;
			//log_icalDebug(JSON.stringify(obj));
			break;
		case "DTSTART":
			obj.dtstart = lObj.value;
			break;
		default:
			if (lObj.key !== "TZNAME" && lObj.key !== "TZOFFSETFROM") {
				log("Current translation from iCal-TZ to webOs event does not understand " + lObj.key + " yet. Will skip line " + lObj.line);
			}
			break;
		}
	}

	function parseTimezone(lObj, tz) {
		if (!tz.standard) {
			tz.standard = {};
		}
		if (!tz.daylight) {
			tz.daylight = {};
		}
		if (tz.standard.mode) {
			parseDaylightStandard(lObj, tz.standard);
			return true;
		} else if (tz.daylight.mode) {
			parseDaylightStandard(lObj, tz.daylight);
			return true;
		}
		switch (lObj.key) {
		case "TZID":
			tz.tzId = lObj.value;
			break;
		case "BEGIN":
			if (lObj.value === "STANDARD") {
				tz.standard.mode = true;
			} else if (lObj.value === "DAYLIGHT") {
				tz.daylight.mode = true;
			}
			break;
		case "END":
			if (lObj.value !== "VTIMEZONE") {
				throw ({name: "SyntaxError", message: "Something went wrong during TIMEZONE parsing, expected END:VTIMEZONE."});
			} else {
				return false; //signal that we are finished
			}
		default:
			if (lObj.key !== "X-LIC-LOCATION") {
				log("My translation from iCal-TZ to webOs event does not understand " + lObj.key + " yet. Will skip line " + lObj.line);
			}
			break;
		}
		return true;
	}

	function buildALARM(alarm, text) {
		var i, field, translation, value;
		translation = {
			"action" : "ACTION",
			//alarmTrigger will be handled extra,
			"attach" : "ATTACH",
			"description" : "DESCRIPTION",
			"duration" : "DURATION",
			"repeat" : "REPEAT",
			//"trigger": "TRIGGER",
			"summary" : "SUMMARY"
		};
		for (i = 0; i < alarm.length; i += 1) {
			text.push("BEGIN:VALARM");
			for (field in alarm[i]) {
				if (alarm[i].hasOwnProperty(field)) {
					if (field === "alarmTrigger") { //use webos fields to allow edit on device.
						text.push("TRIGGER" +
							(alarm[i].alarmTrigger.valueType === "DATETIME" ? ";VALUE=DATE-TIME" : ";VALUE=DURATION") +
							":" + alarm[i].alarmTrigger.value); //only other mode supported by webOs is DURATION which is the default.
					} else if (translation[field]) { //ignore trigger field and other unkown things..
						value = alarm[i][field];
						if (field === "action") {
							value = alarm[i][field].toUpperCase();
						}
						text.push(translation[field] + ":" + value); //just copy most values.
					}
				}
			}
			text.push("END:VALARM");
		}
		return text;
	}

	function parseAttendee(lObj, attendees, organizer) {
		var i = 0, attendee = {}, parts, translation;
		if (!attendees) {
			attendees = [];
		}
		if (lObj.parameters) {
			attendee.email = lObj.parameters.email; //sometimes e-mail is in extra parameter.
			if (!attendee.email) { //if not parse value for "MAILTO:e-mail".
				if (lObj.value.indexOf(":") !== -1) {
					parts = lObj.value.split(":"); //might be mailto:...
					for (i = 0; i < parts.length; i += 1) {
						if (parts[i].indexOf("@") !== -1) { //if part contains an @ it's not MAILTO and not X-EGROUPWARE... which egroupware seems to add. Strange.
							attendee.email = parts[i];
							break;
						}
					}
				}
			}
		}
		if (organizer) {
			for (i = 0; attendees && i < attendees.length; i += 1) {
				if (attendees[i].email === attendee.email) {
					attendees[i].organizer = true; //found ORGANIZER field for attendee that already was parsed. Do nothing. :)
					return attendees;
				}
			}
			attendee.organizer = true;
		}
		translation = {
			"cn": "commonName",
			"cutype": "calendarUserType",
			"role": "role",
			"partstat": "participationStatus",
			"rsvp": "rsvp",
			"email": "email",
			"member": "member",
			"DELEGATED-FROM": "delegatedFrom",
			"DELEGATED-TO": "delegatedTo",
			"DIR": "dir",
			"LANGUAGE": "language",
			"SENT-BY": "sentBy"
		};
		//translate all the fields:
		for (i in translation) {
			if (translation.hasOwnProperty(i)) {
				if (lObj.parameters[i]) {
					/*if (i === "cn") {
						lObj.parameters.cn = lObj.parameters.cn.replace(/"/g, ""); //remove " from the name if there are some.
					}*/
					attendee[translation[i]] = lObj.parameters[i];
				}
			}
		}
		//if (!attendee.email) {
			//webos calendar requires email field, but some send nothing for groups.
			//attendee.email = "group-placeholder@invalid.invalid";
		//}
		attendees.push(attendee);
		return attendees;
	}

	function buildATTENDEE(attendee) {
		var text = "ATTENDEE", translation, field, res;
		translation = {
			"commonName": "CN",
			"calendarUserType": "CUTYPE",
			"role": "ROLE",
			"participationStatus": "PARTSTAT",
			"rsvp": "RSVP",
			"email": "EMAIL",
			"member": "MEMBER",
			"delegatedFrom": "DELEGATED-FROM",
			"delegatedTo": "DELEGATED-TO",
			"dir": "DIR",
			"language": "LANGUAGE",
			"sentBy": "SENT-BY"
		};
		//if (attendee.email === "group-placeholder@invalid.invalid") {
	 //	delete attendee.email; //remove fake mail
		//}
		for (field in translation) {
			if (translation.hasOwnProperty(field)) {
				if (attendee[field]) {
					text += ";" + translation[field] + "=" + attendee[field];
				}
			}
		}
		text += ":";
		if (attendee.email) {
			text += "MAILTO:" + attendee.email;
			if (attendee.email.indexOf("@") === -1) {
				text += "@mail.invalid"; //prevent parsing errors on some servers.
			}
		}
		res = [text];
		if (attendee.organizer) {
			res.push("ORGANIZER;CN=" + attendee.commonName + (attendee.email ? (":MAILTO:" + attendee.email) : ":"));
		}
		return res;
	}

	function parseLineIntoObject(lObj, event, afterTZ) {
		var translation, translationQuote, transTime, year, future;
		//not in webOs: UID
		//in webos but not iCal: allDay, calendarID, parentId, parentDtStart (???)
		//string arrays: attach, exdates, rdates
		//more complex objects: ATTENDEES, ORGANIZER, BEGIN:VALARM, RRULE
		translation = {
			"CATEGORIES"	:	"categories",
			"CLASS"			:	"classification",
			"GEO"			:	"geo",
			"CONTACT"		:	"contact",
			"PRIORITY"		:	"priority",
			"RELATED-TO"	:	"relatedTo",
			"STATUS"		:	"requestStatus",
			"RESOURCES"		:	"resources",
			"SEQUENCE"		:	"sequence",
			"TRANSP"		:	"transp",
			"TZID"			:	"tzId",
			"URL"			:	"url",
			"RECURRENCE-ID"	:	"recurrenceId",
			"AALARM"		:	"aalarm", //save aalarm.
			"UID"			:	"uId" //try to sed uId. I hope it will be saved in DB although docs don't talk about it. ;)
		};
		translationQuote = {
			"COMMENT"		:	"comment",
			"DESCRIPTION"	:	"note",
			"LOCATION"		:	"location",
			"SUMMARY"		:	"subject"
		};
		transTime = {
			"DTSTAMP"		:	"dtstamp",
			"DTSTART"		:	"dtstart",
			"DTEND"			:	"dtend",
			"CREATED"		:	"created",
			"LAST-MODIFIED"	:	"lastModified"
		};
		//most parameters ignored for the simple objects... hm. But they mostly have none, right?
		if (lObj.key === "TZID") {
			//log_icalDebug("Got TZID: " + lObj.value);
			event.tzId = lObj.value;
			future = TZManager.loadTimezones([event.tzId, localTzId]);
			future.then(afterTZ);
			future.onError(function (f) {
				log("Error in TZManager.loadTimezones-future: " + f.exeption);
				future.result = { returnValue: false };
			});
		}

		if (translation[lObj.key]) {
			event[translation[lObj.key]] = lObj.value;
		} else if (translationQuote[lObj.key]) {
			if (lObj.parameters.encoding === "QUOTED-PRINTABLE" || calendarVersion === 1) {
				lObj.value = quoted_printable_decode(lObj.value);
			}
			event[translationQuote[lObj.key]] = unquote(lObj.value);
		} else if (transTime[lObj.key]) {
			//log_icalDebug("Should call TZManager.loadTimezones for " + event.subject);
			event[transTime[lObj.key]] = lObj.value;
			//log_icalDebug("Trying to load Timezones...")
			year = parseInt(lObj.value.substr(0, 4), 10);
			//log_icalDebug("For year " + year);
			if (!event.tzId && event.tz) {
				event.tzId = event.tz.tzId;
			}
			if (!event.tzId && lObj.parameters.tzid) {
				event.tzId = lObj.parameters.tzid;
			}
			if (event.tzId) {
				future = TZManager.loadTimezones([event.tzId, localTzId], [year]);
				future.then(afterTZ);
				future.onError(function (f) {
					log("Error in TZManager.loadTimezones-future: " + f.exeption);
					future.result = { returnValue: false };
				});
			} else {
				event.loadTimezones -= 1;
				//log_icalDebug("No Timezone in event. Assuming local.");
			}
			//log_icalDebug("TZManager.loadTimezones ok for " + event.subject);
		} else { //one of the more complex cases.
			switch (lObj.key) {
			case "ATTACH": //I still don't get why this is an array?
				if (!event.attach) {
					event.attach = [];
				}
				event.attach.push(lObj.value);
				break;
			case "EXDATE": //EXDATE / RDATE is a list of timestamps . webOs wants them in an array
				event.exdates = parseDATEARRAY(lObj.value); // => split list, fill array. Doc says webos wants the date-time strings not ts like everywhere else.. hm.
				break;
			case "RDATE": //EXDATE / RDATE is a list of timestamps . webOs wants them in an array
				event.rdates = parseDATEARRAY(lObj.value); // => split list, fill array. Doc says webos wants the date-time strings not ts like everywhere else.. hm.
				break;
			case "BEGIN": //ignore begins other than ALARM.
				if (lObj.value === "VALARM") {
					event.alarm.push({}); //add new alarm object.
					event.alarmMode = true;
				} else if (lObj.value === "VTIMEZONE") {
					event.tzMode = true;
				} else if (lObj.value === "VTODO" || lObj.value === "VJOURNAL" || lObj.value === "VFREEBUSY") {
					event.ignoreMode = lObj.value;
				} //will ignore begins of VEVENT, VTIMEZONE and VCALENDAR.
				break;
			case "ORGANIZER":
				//organizer is a full attendee again. Problem: This might cause duplicate attendees!
				//if there is just one attendee, there is just an organizer field and no attendee field at all.
				//but if there are more attendees, then there is an attendee field for the organizer and an
				//organizer field also that also contains most of the data...
				event.attendees = parseAttendee(lObj, event.attendees, true);
				break;
			case "ATTENDEE":
				event.attendees = parseAttendee(lObj, event.attendees, false);
				break;
			case "RRULE":
				event.rrule = parseRRULE(lObj.value);
				break;
			case "VERSION":
				if (lObj.value === "1.0") {
					calendarVersion = 1;
				} else {
					calendarVersion = 2;
				}
				break;
			case "X-FUNAMBOL-ALLDAY":
				if (lObj.value === "1") {
					event.allDay = true;
				} else {
					event.allDay = false;
				}
				break;
			case "X-MICROSOFT-CDO-ALLDAYEVENT":
			case "X-AllDayEvent":
				if (lObj.value.toLowerCase() === "true") {
					event.allDay = true;
				} else {
					event.allDay = false;
				}
				break;
			case "DURATION":
				//this can be specified instead of DTEND.
				event.duration = lObj.value;
				event.loadTimezones -= 1;
				break;
			default:
				if (lObj.key !== "PRODID" && lObj.key !== "METHOD" && lObj.key !== "END") {
					log("My translation from iCal to webOs event does not understand " + lObj.key + " yet. Will skip line " + lObj.line);
				}
				break;
			}
		}
		return event;
	}

	function tryToFillParentId(event) {
		var i, j, revent, ts,	thisTS;
		//try to fill "parent id" and parentdtstamp for exceptions to recurring dates.
		if (event.exdates && event.exdates.length > 0) {
			//log_icalDebug("Event has exdates: " + JSON.stringify(event.exdates) + " remembering it as recurring.");
			event.recurringId = recurringEvents.length; //save index for recurring event to add ids later.
			recurringEvents.push(event);
		}

		//this will only work, if parent was processed before... :(
		if (event.recurrenceId) {
			thisTS = event.recurrenceId; //from webOs-docs recurrenceId is DATETIME not webOs-timestamp.
			for (i = 0; i < recurringEvents.length; i += 1) {
				revent = recurringEvents[i];
				//log_icalDebug("Checking if event is exception for " + JSON.stringify(revent.exdates));
				for (j = 0; j < revent.exdates.length; j += 1) {
					ts = revent.exdates[j];
					//log_icalDebug("Matching TS: " + ts + " = " + thisTS);
					if (ts === thisTS) {
						event.parentDtstart = revent.dtstart;
						event.parentId = revent._id;
						if (!event.parentId) {
							log("Need to add parentId later, because it does not exist, yet. Saving this element as child for parent " + i);
							event.parentLocalId = i;
						} else {
							log_icalDebug("Found parent event with eventId " + revent._id + " ts: " + ts + " this ts " + event.recurrenceId);
						}
						event.relatedTo = revent.uId;
						return event;
					}
				}
			}
		}
		if (event.recurrenceId) {
			log("Did not find parent event. :(");
		}
		return event;
	}

	function convertTimestamps(event) {
		var t, i, directTS = ["dtstart", "dtstamp", "dtend", "created", "lastModified"], makeAllDay = false;
		makeAllDay = event.allDay; //keep allDay setting from possible other cues.
		//log_icalDebug("Converting timestamps for " + event.subject);
		if (!event.tz) {
			if (event.tzId) {
				//log_icalDebug("Did not have tz, setting event.tzId " + event.tzId);
				event.tz = { tzId: event.tzId };
			}
		}
		if (event.dtstart.indexOf("000000") !== -1 &&
				((event.dtend.indexOf("235900") !== -1) ||
				 (event.dtend.indexOf("235959") !== -1) ||
				 (event.dtend.indexOf("000000") !== -1))) {
			makeAllDay = true;
		}
		for (i = 0; i < directTS.length; i += 1) {
			if (event[directTS[i]]) {
				t = iCalTimeToWebOsTime(event[directTS[i]], event.tz);
				event[directTS[i]] = t.ts;
				if (directTS[i] === "dtstart") {
					event.tzId = t.tzId;
					event.allDay = t.allDayCue;
				}
			}
		}

		if (!event.dtend && event.duration) {
			event.dtend = event.dtstart + convertDurationIntoMicroseconds(event.duration);
			log_icalDebug("Created dtend " + event.dtend + " from " + event.duration + " and " + event.dtstart);
			delete event.duration;
		}

		if (event.rrule && event.rrule.until) {
			t = iCalTimeToWebOsTime(event.rrule.until, event.tz);
			event.rrule.until = t.ts;
			event.rrule.untilOffset = t.offset;
		}

		if (makeAllDay) {
			event.allDay = true;
		}
		return event;
	}

	function applyHacks(event, ical, serverId) { //TODO: read product from id to have an idea which hacks to apply.. or similar.
		var i, val, start, diff, tz, parts, tsStruct, date;

		/*if (event.tzId && event.tzId !== "UTC") {
			log_icalDebug("ERROR: Event was not specified in UTC. Can't currently handle anything else than UTC! Expect problems!!!! :(");
			if(event.allDay) {	//only mangling with time, if event is allday event.
				event.tzId = UTC;
			}
		}*/

		//This is not really correct here, because this is not really a hack but necessary for x-vcalendar support.
		//but we just keep that here, it fits so nice.
		if (event.aalarm) {
			//AALARM is not really supported anymore..
			//support only very simple aalarms.
			//mostly this is a DATE-TIME VALARM, so add one. ;)
			if (!event.alarm) {
				event.alarm = [];
			}
			parts = event.aalarm.split(";");
			for (i = 0; i < parts.length; i += 1) {
				if (DATETIME.test(parts[i])) {
					event.alarm.push({ alarmTrigger: { value: parts[i], valueType: "DATETIME" } });
				}
			}
		}

		//webOs does not support DATE-TIME as alarm trigger. Try to calculate a relative alarm from that...
		//issue: this does not work, if server and device are in different timezones. Then the offset from
		//server to GMT still exists... hm.
		for (i = 0; event.alarm && i < event.alarm.length; i += 1) {
			if (event.alarm[i].alarmTrigger.valueType === "DATETIME" || event.alarm[i].alarmTrigger.valueType === "DATE-TIME") {
				tz = event.tz;
				if (!tz) {
					if (event.tzId) {
						tz = { tzId: event.tzId };
					}
				}
				//log_icalDebug("Calling iCalTimeToWebOsTime with " + event.alarm[i].alarmTrigger.value + " and " + {tzId: event.tzId});
				tsStruct = iCalTimeToWebOsTime(event.alarm[i].alarmTrigger.value, {tzId: event.tzId});
				val = tsStruct.ts;
				val -= tsStruct.offset;
				log_icalDebug("Hacking alarm, got alarm TS: " + val);
				log_icalDebug("Value: " + event.alarm[i].alarmTrigger.value);
				log_icalDebug("Val: " + val);
				start = event.dtstart;
				log_icalDebug("Start is: " + start);
				log_icalDebug("start: " + start);
				date = new Date(start);
				log_icalDebug("Date: " + date);
				diff = (val - start) / 60000; //now minutes.
				log_icalDebug("Diff: " + diff);
				log_icalDebug("Diff is " + diff);
				if (event.allDay) {
					diff += date.getTimezoneOffset(); //remedy allday hack.
					log_icalDebug("localized: " + diff);
				}
				if (diff < 0) {
					val = "-PT";
					diff *= -1;
				} else {
					val = "PT";
				}
				log_icalDebug("Diff after < 0: " + diff + " val: " + val);
				if (diff / 10080 >= 1) { //we have weeks.
					val += (diff / 10080).toFixed() + "W";
				} else if (diff / 1440 >= 1) { //we have days. :)
					val += (diff / 1440).toFixed() + "D";
					log_icalDebug("Day: " + val);
				} else if (diff / 60 >= 1) {
					val += (diff / 60).toFixed() + "H";
					log_icalDebug("Hour: " + val);
				} else {
					val += diff + "M";
					log_icalDebug("Minutes: " + val + ", diff: " + diff);
				}
				log_icalDebug("Val is: " + val);
				event.alarm[i].alarmTrigger.value = val;
				event.alarm[i].alarmTrigger.valueType = "DURATION";
				log_icalDebug("Hacked alarm to " + JSON.stringify(event.alarm[i]));
			}
		}

		//allday events that span more than one day get one day to long in webOs.
		//webOs itself defines allDay events from 0:00 on the first day to 23:59 on the last day.
		//BUT, to avoid issues with timezones, we now set allday events to be from 12:00:00 to 12:00:01
		//So we need to subtract a whole day here, because it is now on 12:00:00 on the day after the event finished.
		//so substracting one second should repair this issue (hopefully :().
		if (event.allDay) { //86400000 = one day.
			event.dtend -= 86399000;
		}
		return event;
	}

	function removeHacks(event, serverId) {
		if (event.allDay) {
			//43200000 = 12 hours => 0 o'clock, -1 second, because we start from 12:00:01.
			event.dtend += 43199000;
		}

		return event;
	}

	//x-vcalendar things:
	function prepareXVCalendar(event) {
		var i, ts, alarmValue, parts, date, sign;

		log_icalDebug("Converting to x-vcalendar: " + JSON.stringify(event));
		for (i = 0; event.alarm && i < event.alarm.length; i += 1) {
			if (event.alarm[i].alarmTrigger.value !== "none") {
				if (event.alarm[i].alarmTrigger.valueType === "DURATION") {
					log_icalDebug("Got duration-alarm " + event.alarm[i].alarmTrigger.value + " and converting it to aalarm.");
					ts = event.dtstart;
					alarmValue = event.alarm[i].alarmTrigger.value;
					ts += convertDurationIntoMicroseconds(alarmValue);

					event.aalarm = webOsTimeToICal(ts, false, event.tzId || localTzId);
					log_icalDebug("Found alarm: " + JSON.stringify(event.alarm[i]) + ", created: " + event.aalarm);
					break;
				} else {
					event.aalarm = event.alarm[i].alarmTrigger.value;
					//log_icalDebug("Found alarm: " + JSON.stringify(event.alarm[i]) + ", created: " + event.aalarm);
				}
			}
		}
		delete event.alarm;
		delete event.tzId;

		if (event.allDay) {
			//event.allDay = false;
			date = new Date(event.dtstart);
			date.setHours(0);
			date.setMinutes(0);
			date.setSeconds(0);
			event.dtstart = date.getTime();
			date = new Date(event.dtend);
			if (date.getHours() !== 0) {
				date.setHours(0);
				date.setDate(date.getDate() + 1);
			}
			date.setMinutes(0);
			date.setSeconds(0);
			event.dtend = date.getTime();
		}
		return event;
	}

	function generateICalIntern(event) {
		var field = "", i, line, offset, text = [], translation, translationQuote, transTime, allDay, quoted, result;
		//not in webOs: UID
		//in webos but not iCal: allDay, calendarID, parentId, parentDtStart (???)
		//string arrays: attach, exdates, rdates
		//more complex objects: ATTENDEES, ORGANIZER, BEGIN:VALARM, RRULE
		translation = {
			"categories"		:	"CATEGORIES",
			"classification"	:	"CLASS",
			"geo"				:	"GEO",
			"contact"			:	"CONTACT",
			"priority"			:	"PRIORITY",
			"relatedTo"			:	"RELATED-TO",
			"requestStatus"		:	"STATUS",
			"resources"			:	"RESOURCES",
			"sequence"			:	"SEQUENCE",
			//"transp"			:	"TRANSP", //intentionally skip this to let server decide...
			//"tzId"			:	"TZID", //skip this. It's not used anyway by most, and we now transmit everything using UTC.
			"url"				:	"URL",
			"recurrenceId"		:	"RECURRENCE-ID;VALUE=DATE-TIME",
			"aalarm"			:	"AALARM",
			"uId"				:	"UID" //try to sed uId. I hope it will be saved in DB although docs don't talk about it. ;)
		};
		translationQuote = {
			"comment"			:	"COMMENT",
			"note"				:	"DESCRIPTION",
			"location"			:	"LOCATION",
			"subject"			:	"SUMMARY"
		};
		transTime = {
			//"dtstamp"			:	"DTSTAMP",
			"created"			:	"CREATED",
			"lastModified"		:	"LAST-MODIFIED",
			"dtstart"			:	"DTSTART",
			"dtend"				:	"DTEND"
		};
		if (event._del === true) {
			return "";
		}
		/*if (!event.tzId) {
			event.tzId = localTzId;
		}*/
		log_icalDebug("Generating iCal for event " + JSON.stringify(event));
		text.push("BEGIN:VCALENDAR");
		if (calendarVersion === 1) {
			text.push("VERSION:1.0");
		} else {
			text.push("VERSION:2.0");
		}
		//text.push("PRODID:MOBO.SYNCML.0.0.3");
		text.push("METHOD:PUBLISH");
		text.push("BEGIN:VEVENT");
		for (field in event) {
			if (event.hasOwnProperty(field)) {
				if (translation[field]) {
					if (field !== "aalarm" || calendarVersion === 1) {
						text.push(translation[field] + ":" + event[field]);
					}
				} else if (translationQuote[field] && event[field] !== "") {
					if (calendarVersion === 1) {
						quoted = quoted_printable_encode(event[field]);
						if (quoted !== event[field]) {
							text.push(translationQuote[field] + ";CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:" + quoted);
						} else { //don't add quoted tags if qouting was not necessary.
							text.push(translationQuote[field] + ":" + quoted);
						}
					} else {
						text.push(translationQuote[field] + ":" + quote(event[field]));
					}
				} else if (transTime[field]) {
					allDay = event.allDay;
					if (field !== "dtstart" && field !== "dtend") {
						allDay = false;
					}
					text.push(transTime[field] +
						(allDay ? ";VALUE=DATE:" : ":") + webOsTimeToICal(event[field], allDay, event.tzId));
				} else { //more complex fields.
					switch (field) {
					case "attach":
						text.push("ATTACH:" + event.attach.join("")); //still don't have a clue why this is an array..
						break;
					case "exdates":
						if (event.exdates.length > 0) {
							text.push("EXDATE;VALUE=DATE-TIME:" + event.exdates.join(","));
						}
						break;
					case "rdates":
						text.push("RDATE:" + event.rdates.join(","));
						break;
					case "alarm":
						if (calendarVersion === 2) {
							text = buildALARM(event.alarm, text);
						}
						break;
					case "attendees":
						for (i = 0; event.attendees && i < event.attendees.length; i += 1) {
							text = text.concat(buildATTENDEE(event.attendees[i]));
						}
						break;
					case "rrule":
						if (event.rrule) {
							if (calendarVersion === 1) {
								text.push(buildRRULEvCalendar(event.rrule, event.tzId));
							} else {
								text.push(buildRRULE(event.rrule, event.tzId)); //tzId needed for until date.
							}
						}
						break;
					default:
						if (field !== "_id" && field !== "_kind" && field !== "_rev" && field !== "parentId" && field !== "allDay" &&
								field !== "eventDisplayRevset" && field !== "parentDtstart" && field !== "calendarId" &&
								field !== "transp" && field !== "accountId" && field !== "dtstamp" && field !== "created" &&
								field !== "lastModified" && field !== "tz" && event[field] !== "") {
							log("Unknown field " + field + " in event object with value " + JSON.stringify(event[field]));
						}
						break;
					}
				}
			}
		} //field loop

		text.push("X-FUNAMBOL-ALLDAY:" + (event.allDay ? "1" : "0"));
		text.push("X-MICROSOFT-CDO-ALLDAYEVENT:" + (event.allDay ? "TRUE" : "FALSE"));
		text.push("X-AllDayEvent:" + (event.allDay ? "TRUE" : "FALSE"));
		text.push("END:VEVENT");
		text.push("END:VCALENDAR");

		//lines "should not" be longer than 75 chars in icalendar spec.
		if (calendarVersion !== 1) { //vcalendar spec read like this is optional. But breaks are only allowed in whitespaces. => ignore that.
			for (i = 0; i < text.length; i += 1) {
				text[i] = fold(text[i]);
			}
		}
		result = text.join("\r\n");
		log_icalDebug("Resulting iCal: " + result);
		return result;
	}

	return {
		parseICal: function (ical, serverData, callback) { // 6 === 1 + transTime.length in parseLineIntoObj, this is important.
			var proc, lines, lines2, line, j, i, lObj, event = {alarm: [], loadTimezones: 6,
					comment: "", note: "", location: "", subject: "", attendees: [], rrule: null}, alarm, tzContinue, afterTZ, outerFuture = new Future();
			//used for timezone mangling.
			afterTZ = function (future) {
				try {
					event.loadTimezones -= 1;
					if (event.loadTimezones === 0) {
						delete event.loadTimezones;
						event = convertTimestamps(event);
						event = applyHacks(event, ical, serverData.serverId);
						outerFuture.result = {returnValue: true, result: event};
						if (callback) {
							callback(event);
						}
					}
				} catch (e) {
					outerFuture.result = {returnValue: false, result: event};
					log(e);
				}
			};

			try {
				proc = ical.replace(/\r\n /g, ""); //remove line breaks in key:value pairs.
				proc = proc.replace(/\n /g, ""); //remove line breaks in key:value pairs.
				proc = proc.replace(/\=\r\n/g, ""); //remove old line breaks in key:value pairs.
				proc = proc.replace(/\=\n/g, ""); //remove old line breaks in key:value pairs.
				//log_icalDebug("Incomming iCal: " + ical);
				lines = proc.split("\r\n"); //now every line contains a key:value pair => split them. somehow the \r seems to get lost somewhere?? is this always the case?
				for (i = 0; i < lines.length; i += 1) {
					lines2 = lines[i].split("\n");
					for (j = 0; j < lines2.length; j += 1) {
						line = lines2[j];
						if (line !== "") { //filter possible empty lines.
							lObj = parseOneLine(line);
							if (event.alarmMode) {
								alarm = parseAlarm(lObj, event.alarm[event.alarm.length - 1]);
								if (alarm) {
									event.alarm[event.alarm.length - 1] = alarm;
								} else {
									delete event.alarmMode; //switch off alarm mode.
								}
							} else if (event.tzMode) {
								if (!event.tz) {
									event.tz = {};
								}
								tzContinue = parseTimezone(lObj, event.tz);
								if (!tzContinue) {
									delete event.tzMode;
								}
							} else if (event.ignoreMode) {
								if (lObj.key === "END" && event.ignoreMode === lObj.value) { //make sure you ignore from the correct begin to the correct end.
									delete event.ignoreMode;
								}
							} else {
								event = parseLineIntoObject(lObj, event, afterTZ);
							}
						}
					}
				}
				log_icalDebug("Parsing finished, event: " + JSON.stringify(event));

				event = tryToFillParentId(event);

				if (!event.dtstamp) {
					event.loadTimezones -= 1;
				}
				if (!event.created) {
					event.loadTimezones -= 1;
				}
				if (!event.lastModified) {
					event.loadTimezones -= 1;
				}
				event.loadTimezones -= 1; //signal that we are finished with everything else.
				//see future of loadTimezones!
				if (event.loadTimezones <= 0) {
					delete event.loadTimezones;
					event = convertTimestamps(event);
					event = applyHacks(event, ical, serverData.serverId);
					outerFuture.result = {returnValue: true, result: event};
					if (callback) {
						callback(event);
					}
				} //else, wait for TZManager to load up tz information.
			} catch (e) {
				outerFuture.result = {returnValue: false, result: event};
				log(e);
			}

			return outerFuture;
		},

		generateICal: function (event, serverData) {
			var years = [], outerFuture = new Future(), future, result;
			try {
				event = removeHacks(event, serverData.serverId);
				if (serverData.serverType === "text/x-vcalendar") {
					event = prepareXVCalendar(event);
				}

				if (event.tzId && event.tzId !== localTzId && event.tzId !== "UTC") {
					years.push(new Date(event.dtstart).getFullYear());
					years.push(new Date(event.dtend).getFullYear());
					if (event.lastModified) {
						years.push(new Date(event.lastModified).getFullYear());
					}
					if (event.created) {
						years.push(new Date(event.created).getFullYear());
					}
					//for timezone mangling.
					future = TZManager.loadTimezones([event.tzId, localTzId], years);
					future.then(this, function (future) {
						//log_icalDebug("loadTimezones returned: ");
						//log_icalDebug(JSON.stringify(future.result));
						try {
							calendarVersion = 2; //TODO: can we get that from server?
							result = generateICalIntern(event);
							outerFuture.result = { returnValue: true, result: result};
						} catch (e) {
							log("Error in generateICal (intern): ");
							log(JSON.stringify(e));
						}
					});
					future.onError(function (f) {
						log("Error in TZManager.loadTimezones-future: " + f.exeption);
						future.result = { returnValue: false };
					});
				} else {
					result = generateICalIntern(event, serverData.serverType);
					outerFuture.result = { returnValue: true, result: result};
				}
			} catch (e) {
				log("Error in generateICal: ");
				log(JSON.stringify(e));
			}

			return outerFuture;
		},

		initialize: function () {
			var future = new Future();

			if (!this.haveSystemTime) {
				log_icalDebug("iCal: need systemTime!");
				future.nest(PalmCall.call("palm://com.palm.systemservice", "time/getSystemTime", { "subscribe": false}));
				future.then(this, function palmCallReturn() {
					var result = future.result;
					if (result.timezone) {
						localTzId = result.timezone;
						log_icalDebug("Got local timezone: " + localTzId);
					}
					this.haveSystemTime = true;
					future.result = { returnValue: true };
				});
			} else { //already have system time.
				future.result = { returnValue: true };
			}

			future.then(this, function initializeTZManager() {
				if (!this.TZManagerInitialized) {
					log_icalDebug("iCal: init TZManager");
					future.nest(TZManager.setup());
					future.then(this, function tzManagerReturn() {
						var result = future.result;
						log_icalDebug("TZManager initialized");
						this.TZManagerInitialized = true;
						future.result = { returnValue: true };
					});
				} else { //TZManager already initialized.
					future.result = { returnValue: true };
				}
			});

			future.then(this, function endInit() {
				log_icalDebug("iCal init checking " + this.haveSystemTime + " - " + this.TZManagerInitialized);
				var result = future.result;
				if (this.haveSystemTime && this.TZManagerInitialized) {
					log_icalDebug("iCal init finished");
				}
				future.result = { iCal: true};
			});

			future.onError(function () {
				log("Error in iCal.initialize: " + future.exeption);
				future.result = { returnValue: false };
			});

			return future;
		}
	}; //end of public interface
}());
