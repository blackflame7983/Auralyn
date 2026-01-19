const checker = require('license-checker');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'src/assets/licenses-npm.json');

console.log('Generating NPM license data...');

checker.init({
    start: __dirname,
    production: true, // DevDependenciesを除外する場合はtrue
    json: true,
    customFormat: {
        licenseText: '', // これを含めることでlicenseTextフィールドが追加されるが、license-checkerのバージョンによっては動作が怪しいので後処理で読む
    }
}, (err, packages) => {
    if (err) {
        console.error('Error generating licenses:', err);
        process.exit(1);
    }

    // license-checkerのJSON出力には通常licenseFileパスが含まれる。
    // これを読み込んでlicenseTextとして埋め込む。
    // また、データを整形する。

    const licenses = {};
    const libraries = [];

    Object.keys(packages).forEach(pkgName => {
        const pkg = packages[pkgName];
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

        libraries.push({
            id: pkgName,
            ...pkg,
            license: licenseKey,
            // Remove huge text fields from the library entry
            licenseText: undefined,
            licenseFile: undefined
        });
    });

    const outputData = {
        licenses,
        libraries
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(outputData, null, 2));
    console.log(`License data with text written to ${OUTPUT_PATH}`);
});
