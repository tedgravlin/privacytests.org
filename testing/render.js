// imports
const { existsSync, promises : fs, constants : fsConstants } = require('fs');
const path = require('path');
const fileUrl = require('file-url');
const open = require('open');
const minimist = require('minimist');
const datauri = require('datauri/sync');
const template = require('./template.js');
const _ = require('lodash');

const browserLogoDataUri = _.memoize((browserName) =>
  datauri(`node_modules/browser-logos/src/${browserName}/${browserName}_128x128.png`).content);

// Deep-copy a JSON structure (by value)
const deepCopy = (json) => JSON.parse(JSON.stringify(json));

// An HTML table with styling
const htmlTable = ({ headers, body, className }) => {
  elements = [];
  elements.push(`<table class="${className}">`);
  elements.push("<tr>");
  for (let header of headers) {
    elements.push(`<th class="table-header" style="text-transform: capitalize;">${header}</th>`);
  }
  elements.push("</tr>");
  let firstSubheading = true;
  for (let row of body) {
    elements.push("<tr>");
    for (let item of row) {
      if (item.subheading) {
        let description = (item.description ?? "").replaceAll(/\s+/g, " ").trim();
        className = firstSubheading ? "first subheading" : "subheading";
        elements.push(`<th colspan="4" class="${className}" title="${description}">${item.subheading}</th>`);
        firstSubheading = false;
      } else {
        elements.push(`<td>${item}</td>`);
      }
    }
    elements.push("</tr>");
  }
  elements.push("</table>");
  return elements.join("");
};

const dropMicroVersion = (version) =>
  version.split(".").slice(0,2).join(".");

// Takes the results for tests on a specific browser,
// and returns an HTML fragment that will serve as
// the header for the column showing thoses tests.
const resultsToDescription = ({
  browser,
  reportedVersion,
  capabilities: { os, os_version, browser: browser2, browserName, browserVersion, version,
                  browser_version, device, platformVersion, platformName, platform },
  prefs, incognito, tor,
}) => {
  let browserFinal = browser || browserName || browser2;
  let browserVersionLong =  reportedVersion || browserVersion || version;
  let browserVersionShort =  dropMicroVersion(browserVersionLong) || "???";
  let platformFinal = platformName || os || platform;
  let platformVersionFinal = platformVersion || "";
  let finalText = `
  <span>
    <img src=${browserLogoDataUri(browser)} width="32" height="32"><br>
    ${browserFinal}<br>
    ${browserVersionShort}
  </span>`;
  if (prefs) {
    for (let key of Object.keys(prefs).sort()) {
      if (key !== "extensions.torlauncher.prompt_at_startup") {
        finalText += `<br>${key}: ${prefs[key]}`;
      }
    }
  }
  if (incognito === true) {
    finalText += "<br>private";
  }
  if (tor === true) {
    finalText += "<br>Tor";
  }
  return finalText;
};

const allHaveValue = (x, value) => {
  return Array.isArray(x) ? x.every(item => item === value) : x === value;
};

// Generates a table cell which indicates whether
// a test passed, and includes the tooltip with
// more information.
const testBody = ({passed, testFailed, tooltip, unsupported}) => {
  let allTestsFailed = allHaveValue(testFailed, true);
  let allUnsupported = allHaveValue(unsupported, true);
  let anyDidntPass = Array.isArray(passed) ? passed.some(x => x === false) : (passed === false);
  return `<div class='${(allUnsupported) ? "na" : (anyDidntPass ? "bad" : "good")}'
title = '${ tooltip.replace(/'/g, "&#39;") }'> ${allUnsupported ? "&ndash;" : "&nbsp;"}
</div>`;
};

// Creates a tooltip with fingerprinting test results
// including the test expressions, the actual
// and desired values, and whether the test passed.
const fingerprintingTooltip = fingerprintingItem => {
  let { expression, desired_expression, actual_value,
        desired_value, passed, worker } = fingerprintingItem;
  return `
expression: ${ expression }
desired expression: ${ desired_expression }
actual value: ${ actual_value }
desired value: ${ desired_value }
passed: ${ passed }
${ worker ? "[Worker]" : "" }
  `.trim();
};

// For simple tests, creates a tooltip that shows detailed results.
const simpleToolTip = (result) => {
  let text = "";
  for (let key in result) {
    if (key !== "description") {
      text += `${key}: ${result[key]}\n`;
    }
  }
  return text.trim();
};

const joinIfArray = x => Array.isArray(x) ? x.join(", ") : x;

const crossSiteTooltip = (
  { write, read, readSameFirstParty, readDifferentFirstParty, passed, testFailed, unsupported }
) => {
  return `
write: ${ write }

read: ${ read }

result, same first party: ${ joinIfArray(readSameFirstParty) }

result, different first party: ${ joinIfArray(readDifferentFirstParty) }

unsupported: ${ joinIfArray(unsupported) }

passed: ${ joinIfArray(passed) }

test failed: ${ joinIfArray(testFailed) }
`.trim();
};

const resultsSection = ({bestResults, category, tooltipFunction, wordBreak}) => {
//  console.log(results);
let section = [];
let bestResultsForCategory = bestResults[0]["testResults"][category];
if (!bestResultsForCategory) {
  return [];
}
let rowNames = Object.keys(bestResultsForCategory)
      .sort(Intl.Collator().compare);
  let resultMaps = bestResults
      .map(m => m["testResults"][category]);
  for (let rowName of rowNames) {
    let row = [];
    let description = bestResultsForCategory[rowName]["description"] ?? "";
    row.push(`<div style="word-break: ${wordBreak ?? "break-word"}" title=${JSON.stringify(description)}>${rowName}</div>`);
    for (let resultMap of resultMaps) {
      let tooltip = tooltipFunction(resultMap[rowName]);
      let { passed, testFailed, unsupported } = resultMap[rowName];
      row.push(testBody({ passed, testFailed, tooltip, unsupported }));
    }
    section.push(row);
  }
  return section;
};

const sectionDescription = {
  statePartitioning: `
    A common vulnerability of web browsers is that they allow tracking companies
    to 'tag' your browser with some data ('state') that identifies you. When third-party trackers
    are embedded in websites, they can see this identifying data as you browse to different
    websites. Fortunately, it is possible for this category of leaks to be fixed by partitioning
    all data stored in the browser such that no data can be shared between websites.`,
  navigation: `
    When you click a hyperlink to navigate your browser from one site to another, certain
    browser APIs allow the first site to communicate to the second site. These privacy
    vulnerabilities can be fixed by introducing new limits on how much data is transfered
    between sites.`,
  https: `
    HTTPS is the protocol that web browsers use to connect securely to websites. When
    HTTPS is being used, the connection is encrypted so
    that third parties on the network cannot read content being sent between the
    server and your browser. In the past, insecure connections were the default and websites
    would need to actively request that a browser use HTTPS. Now the status quo is shifting,
    and browser makers are moving toward a world where HTTPS is the default protocol.`,
  misc: `This category includes tests for the presence of miscellaneous privacy features.`,
  fingerprinting: `
    Fingerprinting is a technique trackers use to uniquely identify you as you browse the web.
    A fingerprinting script will measure several characteristics of your browser and, combining
    this data, will build a fingerprint that may uniquely identify you among web users.
    Browsers can introduce countermeasures, such as minimizing the distinguishing information
    disclosed by certain web APIs so your browser is harder to pick out from the crowd
    (so-called 'fingerprinting resistance').`,
  queryParameters: `
    When you browse from one web page to another, tracking companies will frequently attach
    a 'tracking query parameter' to the address of the second web page. That query parameter
    may contain a unique identifier that tracks you individually as you browse the web. And
    these query parameters are frequently synchronized with cookies, making them a powerful
    tracking vector. Web browsers can protect you from known tracking query parameters by
    stripping them from web addresses before your browser sends them. (The set of
    tracking query parameters tested here was largely borrowed from Brave.)`};

const resultsToTable = (results, title) => {
  console.log(results);
  let bestResults = results
      .filter(m => m["testResults"])
      .filter(m => m["testResults"]["supercookies"])
      .sort((m1, m2) => m1["browser"] ? m1["browser"].localeCompare(m2["browser"]) : -1);
      console.log(bestResults[0]);
  let headers = bestResults.map(resultsToDescription);
  headers.unshift(`<h1 class="title">${title}</h1>`);
  let body = [];
  if (bestResults.length === 0) {
    return [];
  }
  body.push([{subheading:"State Partitioning tests", description: sectionDescription.statePartitioning}]);
  body = body.concat(resultsSection({bestResults, category:"supercookies", tooltipFunction: crossSiteTooltip}));
  body.push([{subheading:"Navigation tests", description: sectionDescription.navigation}]);
  body = body.concat(resultsSection({bestResults, category:"navigation", tooltipFunction: crossSiteTooltip}));
  body.push([{subheading:"HTTPS tests", description: sectionDescription.https }]);
  body = body.concat(resultsSection({bestResults, category:"https", tooltipFunction: simpleToolTip}));
  body.push([{subheading:"Misc tests", description: sectionDescription.misc}]);
  body = body.concat(resultsSection({bestResults, category:"misc", tooltipFunction: simpleToolTip}));
  body.push([{subheading:"Fingerprinting resistance tests", description: sectionDescription.fingerprinting}]);
  body = body.concat(resultsSection({bestResults, category:"fingerprinting", tooltipFunction: fingerprintingTooltip, wordBreak: "break-all"} ));
  body.push([{subheading:"Tracking query parameter tests", description: sectionDescription.queryParameters}]);
  body = body.concat(resultsSection({bestResults, category:"query", tooltipFunction: simpleToolTip}));
  return { headers, body };
};

// Create the title HTML for a results table.
const tableTitle = `<div class="table-title">Desktop Browsers</div>
  <div class="instructions">(point anywhere for more info)</a>`;

// Create dateString from the given date and time string.
const dateString = (dateTime) => {
  let dateTimeObject = new Date(dateTime);
  return dateTimeObject.toISOString().split("T")[0];
};

// Creates the table content for a page.
const content = (results, jsonFilename) => {
  let { headers, body } = resultsToTable(results.all_tests,  tableTitle);
  return `<div id="banner"><div>Open-source tests of web browser privacy.</div><div>Updated ${dateString(results.timeStarted)}</div></div>` +
  htmlTable({headers, body,
                    className:"comparison-table"}) +
	`<p class="footer">Tests ran at ${results.timeStarted.replace("T"," ").replace(/\.[0-9]{0,3}Z/, " UTC")}.
         Source version: <a href="https://github.com/arthuredelstein/browser-privacy/tree/${results.git}"
    >${results.git.slice(0,8)}</a>.
    Raw data in <a href="${jsonFilename}">JSON</a>.
    </p>`;
};

// Reads in a file and parses it to a JSON object.
const readJSONFile = async (file) =>
    JSON.parse(await fs.readFile(file));

// Returns the path to the latest results file in
// the given directory.
const latestResultsFile = async (dir) => {
  let files = await fs.readdir(dir);
  let stem = files
      .filter(f => f.match("^(.*?)\.json$"))
      .sort()
      .pop();
  return dir + "/" + stem;
};

// List of results keys that should be collected in an array
const resultsKeys = [
  "passed", "testFailed",
  "readSameFirstParty", "readDifferentFirstParty",
  "actual_value", "desired_value",
  "IsTorExit", "cloudflareDoH", "nextDoH", "result", "unsupported", "upgraded"
];

// Finds any repeated trials of tests and aggregate the results
// for a simpler rendering.
const aggregateRepeatedTrials = (results) => {
  let aggregatedResults = new Map();
  for (let test of results.all_tests) {
    if (test.testResults) {
      let key = resultsToDescription(test);
      //console.log(key);
      if (aggregatedResults.has(key)) {
        let theseTestResults = aggregatedResults.get(key).testResults;
        if (theseTestResults) {
          for (let subcategory of ["supercookies", "fingerprinting", "https", "misc", "navigation", "query"]) {
            let someTests = theseTestResults[subcategory];
            for (let testName in test.testResults[subcategory]) {
              for (let value in test.testResults[subcategory][testName]) {
                if (resultsKeys.includes(value)) {
                  if (!Array.isArray(someTests[testName][value])) {
                    someTests[testName][value] = [someTests[testName][value]];
                  }
                  someTests[testName][value].push(test.testResults[subcategory][testName][value]);
                }
              }
            }
          }
        }
      } else {
        aggregatedResults.set(key, deepCopy(test));
      }
    }
  }
  let resultsCopy = deepCopy(results);
  resultsCopy.all_tests = [...aggregatedResults.values()];
  return resultsCopy;
};

const render = async ({ dataFile, live, aggregate }) => {
  console.log("aggregate:", aggregate);
  let resultsFileJSON = dataFile ?? await latestResultsFile("./out/results");
  let resultsFileHTMLLatest = "./out/results/latest.html";
  let resultsFileHTML = resultsFileJSON.replace(/\.json$/, ".html");
//  fs.copyFile(resultsFile, "./out/results/" + path.basename(resultsFile), fsConstants.COPYFILE_EXCL);
  console.log(`Reading from raw results file: ${resultsFileJSON}`);
  let results = await readJSONFile(resultsFileJSON);
  console.log(results.all_tests.length);
  let processedResults = aggregate ? aggregateRepeatedTrials(results) : results;
//  console.log(results.all_tests[0]);
//  console.log(JSON.stringify(results));
  await fs.writeFile(resultsFileHTMLLatest, template.htmlPage({
    title: "PrivacyTests.org",
    content: content(processedResults, path.basename(resultsFileJSON)),
    cssFiles: ["./template.css", "./inline.css"],
    previewImageUrl: "/preview1.png"
  }));
  console.log(`Wrote out ${fileUrl(resultsFileHTMLLatest)}`);
  await fs.copyFile(resultsFileHTMLLatest, resultsFileHTML);
  console.log(`Wrote out ${fileUrl(resultsFileHTML)}`);

  if (!live) {
    open(fileUrl(resultsFileHTML));
  }
};

const main = async () => {
  let { _: [ dataFile], live, aggregate } = minimist(process.argv.slice(2),
                                     opts = { default: { aggregate: true }});
  render({ dataFile, live, aggregate });
};

if (require.main === module) {
  main();
}

module.exports = { render };
