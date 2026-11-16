export function selectTests(files, features) {
    const selected = new Set();
    for (const file of files) {
        if (/^(?:docs|user-docs)\//.test(file) || /^(?:AGENTS|CLAUDE)\.md$/.test(file)) continue;
        const matches = Object.values(features).filter(feature => feature.sources.some(prefix => file === prefix || (prefix.endsWith('/') && file.startsWith(prefix))));
        if (!matches.length) return { full: true, tests: [] };
        for (const feature of matches) for (const test of feature.tests) selected.add(test);
    }
    return { full: false, tests: [...selected] };
}
