import console from "../modules/console.js";
console.info("Start initialization...");
import mkdtmp from "../modules/mkdtmp.js";
import browserify from "browserify";
import minifyStream from "minify-stream";
import uglify from "uglify-js";
import browserifyTargets from "./targets.js";
import fs from "fs";
import path from "path";
import { startGroup, endGroup, exportVariable } from "@actions/core";
import createCommit from "../modules/createCommit.js";
import exec from "../modules/exec.js";
import modulePath from "../modules/modulePath.js";
import jsonModule from "../modules/jsonModule.js";

startGroup("browserifyTargets:");
console.info(browserifyTargets);
endGroup();
const tempPath = await mkdtmp(true);
const inputPath = path.join(tempPath, "input.js");
const [nomalOutput, jsonOutput] = await Promise.all([exec("npm ls"), exec("npm ls --json")]);
console.info("npm ls:", nomalOutput);
const localPackageVersions = JSON.parse(jsonOutput).dependencies;
const fileList = [];
for (const browserifyTarget of browserifyTargets) {
    console.info("target:", browserifyTarget);
    const { module, entry, gadget: { name, fileName }, exportValues, removePlugins, prependCode } = browserifyTarget;
    const file = path.join("src/gadgets", name, fileName);
    fileList.push(file);
    await fs.promises.rm(inputPath, {
        recursive: true,
        force: true,
    });
    const hasExports = Array.isArray(exportValues) && exportValues.length > 0;
    const reference = hasExports ? `{ ${exportValues.join(", ")} }` : "m";
    await fs.promises.writeFile(inputPath, [
        `import ${reference} from "${module}";`,
        `global["${entry}"] = ${reference};`,
    ].join("\n"));
    const codes = await new Promise((res, rej) => {
        console.info(`[${module}]`, "start generating...");
        const plugins = new Set([
            "esmify",
            "common-shakeify",
            "browser-pack-flat/plugin",
        ]);
        if (Array.isArray(removePlugins)) {
            for (const removePlugin of removePlugins) {
                plugins.delete(removePlugin);
            }
        }
        let codeObject = browserify(inputPath).transform("unassertify", { global: true }).transform("envify", { global: true });
        for (const plugin of plugins) {
            codeObject = codeObject.plugin(plugin);
        }
        const codeStream = codeObject.bundle().pipe(minifyStream({
            sourceMap: false,
            uglify,
            mangle: false,
            output: {
                beautify: true,
                width: 1024 * 10,
            },
        }));
        const chunks = [];
        codeStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        codeStream.on("error", (err) => rej(err));
        codeStream.on("end", () => res(Buffer.concat(chunks).toString("utf8")));
    });
    const output = [
        "/**",
        ` * Generated by ${modulePath(import.meta)}`,
        " * Options:",
    ];
    for (const [k, v] of Object.entries(browserifyTarget)) {
        output.push(` *     ${k}: ${JSON.stringify(v, null, 1).replace(/\n */g, " ")}`);
    }
    output.push(" */");
    if (typeof prependCode === "string") {
        output.push(prependCode);
    }
    output.push(codes.trim(), "");
    const code = output.join("\n");
    const oldCode = await fs.promises.readFile(file, {
        encoding: "utf-8",
    }).catch(() => undefined);
    if (code === oldCode) {
        console.info(`[${module}]`, "No change, continue to next one.");
        continue;
    }
    await fs.promises.writeFile(file, code);
    if (path.extname(file) === ".js") {
        const filename = path.basename(file);
        const eslintrcName = path.join(path.dirname(file), ".eslintrc");
        const eslintrc = await jsonModule(eslintrcName).catch(() => ({}));
        if (!Array.isArray(eslintrc.ignorePatterns)) {
            eslintrc.ignorePatterns = [];
        }
        if (!eslintrc.ignorePatterns.includes(filename)) {
            eslintrc.ignorePatterns.push(filename);
            await jsonModule.writeFile(eslintrcName, eslintrc);
        }
    }
    console.info(`[${module}]`, "generated successfully.");
    await createCommit(`auto(Gadget-${name}): bump ${module} to ${localPackageVersions[module].version} by browserify`);
}
exportVariable("linguist-generated-browserify", JSON.stringify(fileList));
console.info("Done.");
