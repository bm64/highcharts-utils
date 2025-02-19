const fs = require('fs');
const yaml = require('js-yaml');
const marked = require('marked');
const branchName = require('current-git-branch');
const latestCommit = require('./latest-commit');
const { join } = require('path');
const { jsToESM, htmlToESM } = require('../public/javascripts/tools/jsfiddle-to-esm');
const babel = require("@babel/core");
const browserDetect = require('browser-detect');
const { JSDOM } = require('jsdom');
const https = require('https');
const moment = require('moment'); // Using dateFormat
const { compile } = require('./compile-on-demand');

const fsp = fs.promises;

const {
	getSettings,
	highchartsDir,
	samplesDir,
	useMinifiedCode
} = require('./arguments.js');
const jsdelivrSamplePath = /https:\/\/cdn\.jsdelivr\.net\/gh\/highcharts\/highcharts@[a-z0-9.]+\/samples\/data\//g;
const BUCKET = 'https://s3.eu-central-1.amazonaws.com/staging-vis-dev.highcharts.com';

const getJSON = async (url) => new Promise ((resolve, reject) => {
    https.get(url, (resp) => {
        let data = '';

        // A chunk of data has been recieved.
        resp.on('data', (chunk) => {
            data += chunk;
        });

        // The whole response has been received. Print out the result.
        resp.on('end', () => {
            try {
                resolve(data)
            } catch (e) {
                reject(e);
            }
        });

    }).on("error", (err) => {
        reject(err);
    });
});

/**
 * Get demo.details in form of an object
 */
const getDetails = (path) => {
	let details;
	let detailsFile = join(samplesDir, path, 'demo.details');
	if (fs.existsSync(detailsFile)) {
		details = fs.readFileSync(detailsFile, 'utf8');
		if (details) {
			try {
				details = yaml.load(details);
			} catch (e) {
				console.error(`Error loading ${path}/demo.details:`, e.message);
			}
		}
	}
	return details || {};
}

const getKarmaHTML = () => {
	let files = require(join(highchartsDir, 'test/karma-files.json'));

	files = files.map(file => `
		<script src="/${file}"></script>
	`).join('');

	return `
		${files}
		<div id="qunit"></div>
		<div id="qunit-fixture"></div>
		<div id="container" style="width: 600px; margin 0 auto"></div>
	`
}

/**
 * Test wether a certain file should be replaced with a compiled version
 *
 * @param {string} path The file path
 * @returns {boolean} True if it should be replaced, otherwise false
 */
const shouldUseCompiled = path => (
	path.includes('.src.js')
);

/**
 * Get a list of all the src values for the script tags in an html string
 *
 * @param {string} html The html content
 * @return {Array<string>} Returns list of the src values
 */
const getScriptTagSrcValues = html => {
	const startValue = 'src="';
	const endValue = '"';
	return html
		.split('</script>')
		.filter(str => str.includes(startValue))
		.map(str => {
			const start = str.indexOf(startValue) + startValue.length;
			const end = str.indexOf(endValue, start);
			return str.substr(start, end - start);
		});
};


/**
 * Replace highcharts.com URLs with local equivalents.
 *
 * @param {string} str The string to replace in
 * @param {string} codePath New code path to replace URL base with
 * @return {string} The new string with replacements done
 */
const replaceURLs = (str, codePath) => {

	let ret = str.replace(
		/https:\/\/code\.highcharts\.com\/mapdata/g,
		'/mapdata'
	);

	// Replace code.highcharts.com/stock/hc.js etc.
	// Do not replace URLs with specific versions.
	ret = ret.replace(
		/https:\/\/code\.highcharts\.com\/(stock|maps|gantt|data-grid)(?!\/[0-9\.]+)/g,
		codePath
	);

	// Replace code.highcharts.com/hc.js, code.highcharts.com/modules/x.js etc.
	// Do not replace URLs with specific versions.
	ret = ret.replace(
		/https:\/\/code\.highcharts\.com(?!\/(stock|maps|gantt|data-grid|[0-9\.]+))/g,
		codePath
	);

	ret = ret.replace(
		/https:\/\/www\.highcharts\.com\/samples\/data\//g,
		'/samples/data/'
	);

	ret = ret.replace(
		/https:\/\/cdn\.rawgit\.com\/highcharts\/highcharts\/[a-z0-9\.]+\/samples\/graphics\//g,
		'/samples/graphics/'
	);

	return ret;
};


const getHTML = (req, codePath) => {

	const { theme } = req.session,
		{ useESModules } = getSettings();

	let samplePath = req.query.path;
	let file = join(highchartsDir, 'samples', samplePath, 'demo.html');
	let html = fs.existsSync(file) ?
		fs.readFileSync(file).toString() :
		`<div class="error-message"><strong>${samplePath}/demo.html</strong> does not exist in the file system.</div>`;

	if (codePath) {

		html = replaceURLs(html, codePath);

		/*if (html.indexOf(`${codePath}/mapdata`) !== -1) {
			html = html.replace(
				RegExp(codePath + '\/mapdata', 'g'),
				'/mapdata'
			);
		}
		*/

		// Theme
		if (theme) {
			html += `
			<script src='${codePath}/themes/${theme}.js'></script>
			`;
		}
	}

	// Redirect to local data files
	html = html.replace(
		jsdelivrSamplePath,
		'/samples/data/'
	);

	// Old IE
	let safeCodePath = codePath || 'https://code.highcharts.com';
	html = `
	<!--[if lt IE 9]>
	<script src='${safeCodePath}/modules/oldie-polyfills.js'></script>
	<![endif]-->

	${html}

	<!--[if lt IE 9]>
	<script src='${safeCodePath}/modules/oldie.js'></script>
	<![endif]-->
	`;


	// Validation
	if (
		html.indexOf('http://code.highcharts.com') !== -1 ||
		html.indexOf('http://www.highcharts.com') !== -1
	) {
		html += `
		<script>
		throw 'Do not use http in demo.html. Use secure https. (${samplePath})';
		</script>
		`;
	}

	var error;
	if (html.indexOf('code.highcharts.local') !== -1) {
		error = 'Do not use <code>code.highcharts.local</code> in demo.html. Use <code>code.highcharts.com</code>';
	} else if (getScriptTagSrcValues(html).some(shouldUseCompiled)) {
		error = 'Do not use src.js files in demos. Use .js compiled files.';
	}
	if (error) {
		html += `
		<script>
		document.body.innerHTML = '<div style="text-align: center; color: red; font-size: 4em; margin-top: 30vh">${error}</div>';
		</script>
		`;
	}

	if (useESModules) {
		html = htmlToESM(html, JSDOM);
	}

	return html;
}

const getBranch = () => {
	return branchName({ altPath: highchartsDir });
}

const getLatestCommit = () => {
	const commit = latestCommit(highchartsDir);

	return commit.commit.substr(0, 10);
}

const getThemes = async (req) => {
	const files = await fsp.readdir(`${highchartsDir}/ts/Extensions/Themes`);

	const themes = files.reduce((themes, file) => {
		const name = file.replace(/\.ts$/, '');
		const hyphenated = name
			.replace(/([A-Z])/g, (a, b) => '-' + b.toLowerCase())
			.replace(/^-/, '');
		themes[hyphenated] = {
			name,
			selected: req.session.theme === hyphenated && 'selected'
		};
		return themes;
	}, {
		'': {
			name: 'Default theme'
		}
	});

	return themes;
}

const getLatestTag = () => latestCommit(highchartsDir, true);

const getCSS = (path, codePath) => {
	const cssFile = join(highchartsDir, 'samples', path, 'demo.css');
	let css = '';

	if (fs.existsSync(cssFile)) {
		css =
			fs.readFileSync(cssFile)
			.toString();

		if (codePath) {
			css = replaceURLs(css, codePath);
		}
	}
	return css;
}

const getJS = (path, req, codePath, es6Context) => {
	try {

		const { useESModules } = getSettings();

        let filePath = join(highchartsDir, 'samples', path, 'demo.js');
        let es6FilePath = join(highchartsDir, 'samples', path, 'demo.mjs');

        if (!fs.existsSync(filePath) && fs.existsSync(es6FilePath)) {
            filePath = es6FilePath;
            es6Context = es6Context || {};
            es6Context.isModule = true;
        }

		let js = fs.readFileSync(filePath, 'utf8');

		if (useESModules) {
			js = jsToESM(js, codePath);
		}''

		// Redirect to local data files
		js = js
			.replace(jsdelivrSamplePath, '/samples/data/')
			.replace(
				/https:\/\/www\.highcharts\.com\/samples\/data\//g,
				'/samples/data/'
			);


		// Use Babel to transform for IE
		let browser = browserDetect(req.headers['user-agent']);
		if (browser.name === 'ie') {
			let result = babel.transformSync(js, {
				ast: false,
				presets: [
					['@babel/preset-env', {
						targets: {
							ie: '8'
						}
					}]
				]
			});
			js = result.code;
		}

		// Validation
		let error;
		if (
			js.indexOf('code.highcharts.local') !== -1 ||
			js.indexOf('utils.highcharts.local') !== -1
		) {
			error = 'Do not use <code>code.highcharts.local</code> in demo.js. Use <code>code.highcharts.com</code>';
		}
		if (
			js.indexOf('http://code.highcharts.com') !== -1 ||
			js.indexOf('http://www.highcharts.com') !== -1
		) {
			error = `Do not use http in demo.js. Use secure https. (${path})`;
		}
		if (error) {
			js += `
			document.body.innerHTML += \`
				<div style="padding: 3em; background: red; color: white">
				<h1>Error</h1>
				${error}
				</div>
			\`;
			`;
		}

		if (codePath) {
			js = replaceURLs(js, codePath);
		}

		return js;
	} catch (e) {
		console.error(e);
		return '';
	}
}

const getResources = (path) => {
	let details = getDetails(path);
	let resources = {
		scripts: [],
		styles: []
	}
	if (details.resources) {
		details.resources.forEach((file) => {
			if (/\.js$/.test(file)) {

				file = file
					.replace(
						'https://code.jquery.com/qunit/qunit-2.0.1.js',
						'/javascripts/vendor/qunit-2.0.1.js'
					);
				resources.scripts.push(file);

			} else if (/\.css$/.test(file)) {

				file = file
					.replace(
						'https://code.jquery.com/qunit/qunit-2.0.1.css',
						'/stylesheets/vendor/qunit-2.0.1.css'
					);

				resources.styles.push(file);
			}
		})
	}
	return resources;
}

const getReadme = (path) => {
	let file = join(highchartsDir, 'samples', path, 'readme.md');
	if (fs.existsSync(file)) {
		return marked.parse(fs.readFileSync(file).toString());
	}
}

const getTestNotes = (path) => {
	let file = join(highchartsDir, 'samples', path, 'test-notes.md');
	if (fs.existsSync(file)) {
		return marked.parse(fs.readFileSync(file).toString());
	}
	file = join(highchartsDir, 'samples', path, 'test-notes.html');
	if (fs.existsSync(file)) {
		return fs.readFileSync(file).toString();
	}
}

/**
 * Get the code file path or return errors on failure
 */
const getCodeFile = async (file, req) => {

	const { compileOnDemand } = getSettings(req);

	let relativePath = file.split('?')[0];
	let path;

    if (relativePath.indexOf('/lib/') === 0) {
		relativePath = relativePath.replace('/lib/', '/vendor/')
		path = join(highchartsDir, relativePath);

	} else {
		// Always load source
		if (!useMinifiedCode && !relativePath.includes('/es-modules/')) {
			relativePath = relativePath
				.replace(/\.src\.js$/, '.js')
				.replace(/\.js$/, '.src.js');
		}
		path = join(highchartsDir, 'code', relativePath);
	}

	if (!fs.existsSync(path)) {
		return {
			error: `console.error("File doesn't exist", "${path}");`
    	};
    }
    if (!/\.(js|js\.map|css|svg|ttf)$/.test(path)) {
    	return {
			error: `console.error("File type not allowed", "${path}");`
    	}
    }

	if (compileOnDemand && /\.js$/.test(path)) {
		const js = await compile(relativePath);
		return { js };
	}

    return {
		success: path
    };
}


const getNightlyResult = async (date) => {
	const daysToTry = 5;

	for (let day = 0; day < daysToTry; day++) { // Try some days back
		const dateString = moment(date - day * 24 * 36e5).format('YYYY-MM-DD');
		const url = `${BUCKET}/visualtests/diffs/nightly/${dateString}/visual-test-results.json`;

		let rawJSON;
		try {
			rawJSON = await getJSON(url);

			const compare = JSON.parse(rawJSON);
			Object.keys(compare).forEach(path => {
				if (path !== 'meta') {
					compare[path] = { diff: compare[path].toString() };
				}
			});

			// Handle
			const approvalsJSON = await getJSON('https://vrevs.highsoft.com/api/reviews/latest');
			const approvals = JSON.parse(approvalsJSON);
			Object.keys(approvals.samples).forEach(path => {
				if (path !== 'meta') {
					approvals.samples[path].forEach(approval => {
						if (
							compare[path] &&
							compare[path].diff > 0 &&
							compare[path].diff.toString() === approval.diff.toString()
						) {
							compare[path].comment = {
								symbol: 'check',
								diff: approval.diff,
								title: approval.comment
							};
						}
					});
				}
			});


			return JSON.stringify(compare, null, '  ');
		} catch (e) {
			console.log(
				`Failed to get visual tests for ${dateString}, continuing...` +
				`\n  - ${url}`
			);
		}
	}
	return `Failed to get results ${daysToTry} days back`;
}

module.exports = {
	getBranch,
	getDetails,
	getHTML,
	getCSS,
	getJS,
	getKarmaHTML,
	getLatestCommit,
	getLatestTag,
	getNightlyResult,
	getResources,
	getReadme,
	getTestNotes,
	getThemes,
	getCodeFile
};