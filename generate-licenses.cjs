const checker = require('license-checker');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'src/assets/licenses-npm.json');
// devDependencies だが、生成物（Tailwind の preflight と生成CSS）が配布物に入るため一覧に含める。
const BUNDLED_DEV_PACKAGES = ['tailwindcss'];

console.log('Generating NPM license data...');

const options = {
    start: __dirname,
    production: true, // DevDependenciesを除外する場合はtrue
    json: true,
    customFormat: {
        licenseText: '', // これを含めることでlicenseTextフィールドが追加されるが、license-checkerのバージョンによっては動作が怪しいので後処理で読む
    }
};

const packageName = id => id.slice(0, id.lastIndexOf('@') > 0 ? id.lastIndexOf('@') : id.length);

checker.init(options, (err, production) => {
    if (err) {
        console.error('Error generating licenses:', err);
        process.exit(1);
    }
    checker.init({ ...options, production: false }, (allErr, all) => {
        if (allErr) {
            console.error('Error generating licenses:', allErr);
            process.exit(1);
        }
        const packages = { ...production };
        for (const id of Object.keys(all)) {
            if (BUNDLED_DEV_PACKAGES.includes(packageName(id))) packages[id] = all[id];
        }
        const missing = BUNDLED_DEV_PACKAGES.filter(name => !Object.keys(packages).some(id => packageName(id) === name));
        if (missing.length) {
            console.error(`Bundled packages not installed: ${missing.join(', ')}`);
            process.exit(1);
        }
        writeLicenses(packages);
    });
});

function writeLicenses(packages) {

    // license-checkerのJSON出力には通常licenseFileパスが含まれる。
    // これを読み込んでlicenseTextとして埋め込む。
    // また、データを整形する。

    const licenses = {};
    const libraries = [];

    Object.keys(packages).sort().forEach(pkgName => {
        const pkg = packages[pkgName];

        // Auralyn本体は専用タブでGPL本文を表示するため、第三者一覧には含めない。
        if (pkgName.startsWith('auralyn@') || (pkg.path && path.resolve(pkg.path) === __dirname)) {
            return;
        }

        let licenseText = pkg.licenseText || '';

        // licenseTextが空で、licenseFileが存在する場合、ファイルを読み込む
        if ((!licenseText || licenseText === '') && pkg.licenseFile) {
            try {
                if (fs.existsSync(pkg.licenseFile)) {
                    licenseText = fs.readFileSync(pkg.licenseFile, 'utf8');
                }
            } catch (readErr) {
                console.warn(`Failed to read license file for ${pkgName}:`, readErr.message);
                licenseText = 'License file found but could not be read.';
            }
        }

        if (!licenseText) {
            licenseText = 'License text not included.';
        }

        // Use the license type string as the key, or generate a unique one if it's too generic
        // For simplicity, we'll try to use the license name, but we need to handle duplicates with different texts (rare but possible)
        // Actually, let's use the license text itself as the unique key to determine deduplication, 
        // but mape it to a readable name if possible.
        // A simpler approach: Just map License Name -> Text. If multiple libs have same license name but different text, 
        // we might have a collision.
        // Ideally we check if `licenses[pkg.licenses]` exists and is same text.

        const licenseType = typeof pkg.licenses === 'string' ? pkg.licenses : (Array.isArray(pkg.licenses) ? pkg.licenses.join(', ') : 'Unknown');

        // Simple deduplication strategy:
        // Use licenseType as key. If it exists and text is different, append a suffix.
        let licenseKey = licenseType;
        if (licenses[licenseKey] && licenses[licenseKey] !== licenseText) {
            let counter = 1;
            while (licenses[`${licenseType}-${counter}`] && licenses[`${licenseType}-${counter}`] !== licenseText) {
                counter++;
            }
            licenseKey = `${licenseType}-${counter}`;
        }

        licenses[licenseKey] = licenseText;

        const versionSeparator = pkgName.lastIndexOf('@');
        libraries.push({
            id: pkgName,
            name: versionSeparator > 0 ? pkgName.slice(0, versionSeparator) : pkgName,
            version: versionSeparator > 0 ? pkgName.slice(versionSeparator + 1) : '',
            license: licenseKey,
            repository: pkg.repository,
            publisher: pkg.publisher,
            copyright: pkg.copyright,
        });
    });

    const outputData = {
        licenses,
        libraries
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData, null, 2));
    console.log(`License data with text written to ${OUTPUT_PATH}`);
}
