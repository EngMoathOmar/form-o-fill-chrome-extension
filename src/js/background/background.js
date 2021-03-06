/*global Rules, Logger, Utils, FormUtil, Notification, JSONF, Storage, Testing, createCurrentPopupInIframe, Workflows */
/* eslint complexity:0, max-nested-callbacks: [1,5] */
var lastMatchingRules = [];
var lastActiveTab = null;
var totalMatchesCount = 0;
var runWorkflowOrRule;

/*eslint-disable no-unused-vars*/
var testingMode = false;
/*eslint-enable no-unused-vars*/

// set the browser action badge
var setBadge = function(txt, tabId) {
  chrome.browserAction.setBadgeText({"text": txt, "tabId": tabId});
  chrome.browserAction.setBadgeBackgroundColor({"color": [0, 136, 255, 200], "tabId": tabId});
  Testing.setVar("browser-action-badge-text", txt, "Browser action badge text");
};

// Shows number of matches in the extension's icon
var refreshMatchCounter = function (tab, count) {
  var txt = chrome.i18n.getMessage("no_match_available");
  if (count && count > 0) {
    txt = count.toString();
  }
  setBadge(txt, tab.id);
};

// Testcode: Fill testing HTML with macthing rules
var reportMatchingRulesForTesting = function(matchingRules, lastMatchingWorkflows) {
  /*eslint-disable max-nested-callbacks*/
  var mRule = matchingRules.map(function (rule) {
    return rule.prettyPrint();
  }).join(",");
  /*eslint-enable max-nested-callbacks*/
  Testing.setVar("matching-rules-count", matchingRules.length, "Matching rule #");
  Testing.setVar("matching-rules-text", "[" + mRule + "]", "Matching rules JSON");

  // If there is only one match we need something in the testpage to click on
  if((matchingRules.length + lastMatchingWorkflows.length) === 1) {
    Testing.setVar("popup-html", "<li class='select-rule' data-rule-name='" + matchingRules[0].name.replace(/[^a-zA-Z-]/g, "-").toLowerCase() + "'>" + matchingRules[0].name + "</li>", "Popup HTML (one match)");
  }
};

// When the user changes a tab, search for matching rules for that url
// or matching rules for that content
var onTabReadyRules = function(tabId) {
  // Clear popup HTML
  chrome.browserAction.setPopup({"tabId": tabId, "popup": ""});
  Logger.info("[bg.js] onTabReadyRules on Tab " + tabId);

  chrome.tabs.get(tabId, function (tab) {
    lastMatchingRules = [];

    // return if the tab isn't active anymore
    if (!tab.active) {
      return;
    }

    lastActiveTab = tab;

    // This is a little bit complicated.
    // I wish the chromium API would implement Promises for all that.
    Rules.all().then(function (rules) {
      // First filter all rules that have content matchers
      var relevantRules = rules.filter(function (rule) {
        return typeof rule.content !== "undefined";
      });

      // Send these rules to the content script so it can return the matching
      // rules based on the regex and the pages content
      var message = { "action": "matchContent", "rules": JSONF.stringify(relevantRules)};
      chrome.tabs.sendMessage(tabId, message, function (matchingContentRulesIds) {
        var matchingContentRules;

        // If we found rules that match by content ...
        if(typeof matchingContentRulesIds !== "undefined") {
          // ... select rules that match those ids
          matchingContentRules = rules.filter(function (rule) {
            return matchingContentRulesIds.indexOf(rule.id) > -1;
          });

          // Add the rules to the rule that matches by url
          lastMatchingRules = lastMatchingRules.concat(matchingContentRules);
        } else {
          matchingContentRules = [];
        }
        Logger.info("[bg.js] Got " + matchingContentRules.length + " rules matching the content of the page");

        // Now match those rules that have a "url" matcher
        Rules.match(tab.url).then(function (matchingRules) {
          Logger.info("[bg.js] Got " + matchingRules.length + " rules matching the url of the page");

          // Concatenate matched rules by CONTENT and URL
          lastMatchingRules = lastMatchingRules.concat(matchingRules);

          // Save rules to localStorage for popup to load
          Rules.lastMatchingRules(lastMatchingRules);

          // Now find and save the matching workflows for those rules
          Workflows.matchesForRules(lastMatchingRules).then(function prMatchingWfs(matchingWfs) {
            Workflows.saveMatches(matchingWfs);

            // Show matches in badge
            totalMatchesCount = lastMatchingRules.length + matchingWfs.length;
            refreshMatchCounter(tab, totalMatchesCount);

            // TESTING
            if(!Utils.isLiveExtension()) {
              reportMatchingRulesForTesting(lastMatchingRules, matchingWfs);
            }

            // No matches? Multiple Matches? Show popup when the user clicks on the icon
            // A single match should just fill the form (see below)
            if (totalMatchesCount !== 1) {
              chrome.browserAction.setPopup({"tabId": tab.id, "popup": "html/popup.html"});
              if (!Utils.isLiveExtension()) {
                createCurrentPopupInIframe(tab.id);
              }
            } else if (lastMatchingRules[0].autorun === true) {
              // If the rule is marked as "autorun", execute the rule if only
              // one was found
              Logger.info("[bj.js] Rule is set to autorun");
              FormUtil.applyRule(lastMatchingRules[0], lastActiveTab);
            }
          });
        });

      });
    });
  });
};

// Load running workflow storage
// and run the next step
var onTabReadyWorkflow = function() {
  return new Promise(function (resolve) {
    Storage.load(Utils.keys.runningWorkflow).then(function prOnTabReadyWf(runningWorkflow) {
      // No running workflow?
      if(typeof runningWorkflow === "undefined" || !lastActiveTab) {
        resolve({status: "not_running", runRule: true});
        return;
      }

      // End of workflow reached
      if(runningWorkflow.currentStep >= runningWorkflow.steps.length) {
        FormUtil.displayMessage("Workflow finished!", lastActiveTab);
        Storage.delete(Utils.keys.runningWorkflow);

        // Search for matching rules and workflows
        // to fill the icon again
        runWorkflowOrRule(lastActiveTab.id);

        resolve({status: "finished", runRule: false});
        return;
      }

      // load rule for workflow step
      var ruleNameToRun = runningWorkflow.steps[runningWorkflow.currentStep];
      Logger.info("[background.js] Using workflow step # " + (runningWorkflow.currentStep + 1) + " (" + ruleNameToRun + ")");
      setBadge("#" + (runningWorkflow.currentStep + 1), lastActiveTab.id);

      Rules.findByName(ruleNameToRun).then(function prExecWfStep(rule) {
        if(typeof rule === "undefined") {
          // report not found rule in options, cancel workflow
          FormUtil.displayMessage("Workflow error: rule not found!", lastActiveTab);
          Storage.delete(Utils.keys.runningWorkflow);

          // Search for matching rules and workflows
          runWorkflowOrRule(lastActiveTab.id);

          resolve({status: "rule_not_found", runRule: false});
        } else {
          // Fill with this rule
          FormUtil.displayMessage("Workflow step " + (runningWorkflow.currentStep + 1) + "/" + runningWorkflow.steps.length, lastActiveTab);
          FormUtil.applyRule(rule, lastActiveTab);

          // Save workflow state so we can continue even after a page reload
          Storage.save({
            currentStep: (runningWorkflow.currentStep + 1),
            steps: runningWorkflow.steps
          }, Utils.keys.runningWorkflow).then(function () {
            resolve({status: "running_workflow", runRule: false});
          });
        }
      });

      // Running workflow! Don't run normal rules.
      resolve({status: "running_workflow", runRule: false});
    });
  });
};

// Searches for workflows or rules to run
// Workflows steps are then run and subsequent matching rules are ignored
runWorkflowOrRule = function (tabId) {
  // First check (and run) workflows
  return onTabReadyWorkflow().then(function prOnTabReadyWf(workflowStatus) {
    // If a workflow step has been run, don't run rules
    if(workflowStatus.runRule) {
      onTabReadyRules(tabId);
    }
  });
};

// Fires when a tab becomes active (https://developer.chrome.com/extensions/tabs#event-onActivated)
chrome.tabs.onActivated.addListener(function (activeInfo) {
  runWorkflowOrRule(activeInfo.tabId);
});

// Fires when the URL changes (https://developer.chrome.com/extensions/tabs#event-onUpdated)
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
  if(changeInfo.status && changeInfo.status === "complete") {
    runWorkflowOrRule(tabId);
  }
});

// This event will only fire if NO POPUP is set
// This is the case when only one rule matches
chrome.browserAction.onClicked.addListener(function (){
  FormUtil.applyRule(lastMatchingRules[0], lastActiveTab);
});

// Listen for messages from other background/popup scripts
chrome.extension.onMessage.addListener(function(message, sender, sendResponse) {

  Logger.info("[bj.js] Received message " + JSONF.stringify(message));

  // From popup.js:
  // This receives the index of the rule to apply when there is more than one match
  if (message.action === "fillWithRule") {
    Logger.info("[bg.js] called by popup.js with rule index " + message.index + ", id = " + message.id);
    // Find the rule by id
    var rules = lastMatchingRules.filter(function (rule) {
      return rule.id === message.id;
    });
    FormUtil.applyRule(rules[0], lastActiveTab);
    sendResponse(true);
  }

  // From popup.js:
  // Apply a workflow starting at the first step / rule
  if (message.action === "fillWithWorkflow") {
    // Load previously saved matching workflows
    Workflows.findById(message.id).then(function prLoadMatches(matchingWf) {
      // Now save the steps of that workflow to the storage and
      // mark the current running workflow
      Storage.save({ currentStep: 0, steps: matchingWf.steps }, Utils.keys.runningWorkflow).then(function () {
        onTabReadyWorkflow();
      });
    });
    sendResponse(true);
  }

  // Open an intern URL (aka. options).
  // Callable by content script that otherwise isn't allowed to open intern urls.
  if(message.action === "openIntern" && message.url) {
    Logger.info("[bg.js] received 'openIntern' with url '" + message.url + "'");
    chrome.tabs.create({ "active": true, "url": message.url });
  }

  // Display a notification to the user that the extract has finished
  if(message.action === "extractFinishedNotification") {
    Logger.info("[bg.js] received 'extractFinishedNotification'");
    Notification.create("Extracted your form. Click here to check the options panel for more info.", null, Utils.openOptions);
  }

  // Return the last active tab id
  if(message.action === "lastActiveTabId" && lastActiveTab !== null) {
    Logger.info("[bg.js] received 'lastActiveTabId'. Sending tabId " + lastActiveTab.id);
    sendResponse(lastActiveTab.id);
  }
});

// REMOVE START
// Messages from content.js
chrome.runtime.onConnect.addListener(function (port) {
  port.onMessage.addListener(function(message) {
    if(message.action === "log" && message.message) {
      Logger.store(message.message);
    }
  });
});

chrome.runtime.onMessage.addListener(function (message) {
  if(message.action === "log" && message.message) {
    Logger.store(message.message);
  }
});
// REMOVE END

// Fires when the extension is install or updated
chrome.runtime.onInstalled.addListener(function (details) {
  Logger.info("[bg.js] runtime.onInstalled fired");

  // Called on very first install
  if (details.reason === "install") {
    Notification.create(chrome.i18n.getMessage("first_install_notification"), null, function () {
      Utils.openOptions("#help");
    });
  }

  // Check if tabs are saved or we start from scratch
  Storage.load(Utils.keys.tabs).then(function (tabSettings) {
    // No tab settings found, create one
    if(typeof tabSettings === "undefined") {
      Logger.info("[bg.js] Creating default tab setting");
      Storage.save([{
        "id": 1,
        "name": chrome.i18n.getMessage("tabs_default_name")
      }], Utils.keys.tabs);
    }
  });

  // remove log entries
  Logger.delete();

  // Check if there are notifications to display
  if(Utils.version.indexOf(".") > -1) {
    Notification.forVersion(Utils.version);
  }
});

