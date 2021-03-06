/* global Storage, Utils, Logger, JSONF */
/*eslint no-unused-vars:0 */
var Workflows = {
  load: function() {
    return new Promise(function (resolve) {
      Storage.load(Utils.keys.workflows).then(function prWfLoad(workflows) {
        if(typeof workflows === "undefined") {
          resolve([]);
        } else {
          resolve(workflows);
        }
      });
    });
  },
  findById: function(id) {
    return new Promise(function (resolve) {
      Workflows.load().then(function prFindById(wfs) {
        resolve(wfs.filter(function (wf) {
          return wf.id == id;
        })[0]);
      });
    });
  },
  save: function(workflowData) {
    Logger.info("[g/workflow.js] Saving " + workflowData.length + " workflows");
    return Storage.save(workflowData, Utils.keys.workflows);
  },
  delete: function(workflowId) {
    this.load().then(function(workflows) {
      var newWfs = workflows.filter(function wfFilterDel(wf) {
        return wf.id != workflowId;
      });
      Workflows.save(newWfs);
    });
  },
  matchesForRules: function(rules) {
    return new Promise(function (resolve) {
      // Find workflows that match those rules (start only)
      var matchingRuleNames = rules.map(function cbStepsMap(rule) {
        return rule.name;
      });

      Workflows.load().then(function prMatchesForRules(workflows) {
        var matchingWorkflows = workflows.filter(function cbWfFilter(workflow) {
          return matchingRuleNames.indexOf(workflow.steps[0]) === 0;
        });
        resolve(matchingWorkflows);
      });
    });
  },
  saveMatches: function(workflows) {
    return Storage.save(JSONF.stringify(workflows), Utils.keys.lastMatchingWorkflows);
  },
  loadMatches: function() {
    return new Promise(function (resolve) {
      Storage.load(Utils.keys.lastMatchingWorkflows).then(function (rawMatches) {
        resolve(JSONF.parse(rawMatches));
      });
    });
  }
};

