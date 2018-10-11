/*
 *  openvpn-build — OpenVPN packaging
 *
 *  Copyright (C) 2018 Simon Rozman <simon@rozman.si>
 *
 *  This program is free software; you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License version 2
 *  as published by the Free Software Foundation.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License along
 *  with this program; if not, write to the Free Software Foundation, Inc.,
 *  51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */
/*@cc_on @*/
/*@if (! @__BUILDER_JS__) @*/
/*@set @__BUILDER_JS__ = true @*/


/**
 * Creates a Builder object
 *
 * @returns  Builder object
 */
function Builder()
{
    this.wsh = WScript.CreateObject("WScript.Shell");
    this.fso = WScript.CreateObject("Scripting.FileSystemObject");
    this.env = this.wsh.Environment("Process");

    // Temporary folder.
    this.tempPath = this.env("TEMP");
    if (this.tempPath.substring(this.tempPath.length - 1) != "\\")
        this.tempPath += "\\";

    // Detect the WiX Toolset path.
    this.wixPath = this.env("WIX");
    if (!this.wixPath || this.wixPath.length == 0) {
        // No WiX, no fun.
        throw new Error("The WIX environment is missing or empty. Please, make sure the WiX Toolset is installed correctly.");
    }
    if (this.wixPath.substring(this.wixPath.length - 1) != "\\")
        this.wixPath += "\\";

    this.wixCandleFlags = ["-nologo"];
    this.wixLightFlags = ["-nologo", "-dcl:high"];

    // Get the codepage Windows is using for stdin/stdout/stderr.
    switch (parseInt(this.wsh.RegRead("HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage\\OEMCP"), 10)) {
        case  437: this.cpOEMMime = "cp437"       ; break;
        case  850: this.cpOEMMime = "ibm850"      ; break;
        case  852: this.cpOEMMime = "ibm852"      ; break;
        case 1250: this.cpOEMMime = "windows-1250"; break;
        case 1251: this.cpOEMMime = "windows-1251"; break;
        default  : this.cpOEMMime = null;
    }

    this.force = false;
    this.rules = [];

    return this;
}


/**
 * Builds given file
 * 
 * @param outName  File to build
 */
Builder.prototype.build = function (outName)
{
    var builder = this;
    var stack = [];

    function build(outName)
    {
        var outFileAbsolute = builder.fso.GetAbsolutePathName(outName).toLowerCase();
        stack.push(outFileAbsolute);
        try {
            // Check stack for cycles.
            for (var i = 0, n = stack.length - 1; i < n; i++)
                if (outFileAbsolute == stack[i])
                    throw new Error("Cyclic dependency:\n   " + stack.join("\n    "));

            for (var i in builder.rules) {
                var rule = builder.rules[i];
                for (var j in rule.outNames) {
                    if (outFileAbsolute == builder.fso.GetAbsolutePathName(rule.outNames[j]).toLowerCase()) {
                        // We found the rule to build builder file.

                        // Have we already build this rule in this session?
                        if (rule.built != 0)
                            return rule.built;

                        // Build dependencies.
                        var ts = 0;
                        for (var k in rule.inNames) {
                            var tsInput = build(rule.inNames[k]);
                            if (ts < tsInput)
                                ts = tsInput;
                        }

                        // Is building required?
                        if (!builder.force) {
                            if (builder.fso.FileExists(outName)) {
                                // The output file exists. Compare its timestamp.
                                var tsOutput = builder.fso.GetFile(outName).DateLastModified;
                                if (ts < tsOutput)
                                    return tsOutput;
                            }
                        }

                        // Make sure the output folder exists.
                        builder.makeDir(builder.fso.GetParentFolderName(outName))

                        try {
                            // Build!
                            WScript.Echo("BUILD: " + outName);
                            rule.build(builder);
                        } catch (err) {
                            // Remove all output names should anything go wrong in build.
                            // We don't want half finished zombie output files with fresh
                            // timestamp lying around.
                            for (var i in rule.outNames)
                                builder.removeFile(rule.outNames[i]);

                            throw err;
                        }

                        return rule.build;
                    }
                }
            }

            if (builder.fso.FileExists(outName)) {
                // No rule found to build the file, but the file already exists.
                return builder.fso.GetFile(outName).DateLastModified;
            }

            throw new Error("Don't know how to build \"" + outName + "\".");
        } finally {
            stack.pop();
        }
    }

    build(outName);
}


/**
 * Cleans intermmediate and output files
 */
Builder.prototype.clean = function () {
    for (var i in this.rules)
        this.rules[i].clean(this);
}


/**
 * Creates folder creating all parent folders if required
 * 
 * @param path  Path to folder to create
 * 
 * @returns  true if the folder was created; false if the folder already existed.
 */
Builder.prototype.makeDir = function (path)
{
    var fso = this.fso;

    function makeDir(path)
    {
        if (path == "") return false;
        try {
            // Create folder.
            fso.CreateFolder(path);
            return true;
        } catch (err) {
            switch (err.number) {
                case -2146828230: // "File already exists"
                    return false;
                case -2146828212: // "Path not found"
                    // Create the parent folder.
                    makeDir(fso.GetParentFolderName(path));
                    try {
                        // Create folder.
                        fso.CreateFolder(path);
                        return true;
                    } catch (err) {
                        throw new Error(err.number, "Error creating \"" + path + "\" folder: " + err.message);
                    }
                default:
                    throw new Error(err.number, "Error creating \"" + path + "\" folder: " + err.message);
            }
        }
    }

    return makeDir(this.fso.GetAbsolutePathName(path));
}


/**
 * Deletes a file
 * 
 * @param fileName  Name of the file to delete
 * 
 * @returns  true if the file was deleted; false otherwise.
 */
Builder.prototype.removeFile = function (fileName)
{
    try {
        this.fso.DeleteFile(fileName, true);
        return true;
    } catch (err) {
        switch (err.number) {
            case -2146828235: // "File not found" (pre Windows 10)
            case -2146828212: // "Path not found" (Windows 10)
                return false;
            default:
                throw new Error(err.number, "Error deleting \"" + fileName + "\": " + err.message);
        }
    }
}


/**
 * Executes the command synchronously
 * 
 * @param cmd  Command to execute
 * 
 * @returns  Command exit code
 */
Builder.prototype.exec = function (cmd)
{
    if (!Builder.prototype.__exec) {
        // Initialize static data.
        Builder.prototype.__exec = {
            "re_cr": new RegExp("\\r", "g")
        };
    }

    var result = -1;
    var outputPath = this.tempPath + this.fso.GetTempName();
    try {
        // Execute command and wait for it to finish. Redirect stdout and strerr to a temporary file.
        WScript.Echo("RUN: " + cmd);
        result = this.wsh.Run("\"" + this.env("ComSpec") + "\" /S /C \"" + cmd + " > \"" + outputPath + "\" 2>&1\"", 0, true);

        var dat = WScript.CreateObject("ADODB.Stream");
        var output = "";
        dat.Open();
        try {
            // Load its output.
            dat.Type = adTypeText;
            if (this.cpOEMMime)
                dat.Charset = this.cpOEMMime;
            dat.LoadFromFile(outputPath);
            output = (new String(dat.ReadText(adReadAll))).replace(Builder.prototype.__exec.re_cr, "");
        } finally {
            dat.Close();
        }

        // Replay all output on our console.
        WScript.Echo(output);
    } finally {
        this.removeFile(outputPath);
    }

    return result;
}


/**
 * Creates a generic build rule
 * 
 * @param outNames  Array of output files
 * @param inNames   Array of input files
 * 
 * @returns  Build rule
 */
function BuildRule(outNames, inNames)
{
    this.outNames = outNames;
    this.inNames  = inNames;
    this.built    = 0;

    return this;
}


/**
 * Blank build rule
 * 
 * @param builder  The builder object
 */
BuildRule.prototype.build = function ()
{
    this.built = (new Date()).getVarDate();
}


/**
 * Removes all output files
 * 
 * @param builder  The builder object
 */
BuildRule.prototype.clean = function (builder)
{
    for (var i in this.outNames)
        builder.removeFile(this.outNames[i]);
}


/**
 * Creates a text preprocessing build rule
 * 
 * @param outName     Output .txt file name
 * @param outCharset  Charset to use on output (e.g. "utf-8", "windows-1251" etc.)
 * @param outLineSep  Line separator on output (e.g. adCRLF, adLF)
 * @param inName      Input .txt.in file name
 * @param inCharset   Charset to expect on input (e.g. "utf-8", "windows-1251" etc.)
 * @param inLineSep   Line separator on input (e.g. adCRLF, adLF)
 * @param ver         M4 parser
 * @param depNames    Additional dependencies
 *
 * @returns  Build rule
 */
function PreprocessBuildRule(outName, outCharset, outLineSep, inName, inCharset, inLineSep, ver, depNames)
{
    this.outCharset = outCharset;
    this.outLineSep = outLineSep;
    this.inCharset = inCharset;
    this.inLineSep = inLineSep;
    this.ver = ver;

    return BuildRule.call(this, [outName], [inName].concat(depNames));
}


/**
 * Builds the rule
 * 
 * @param builder  The builder object
 */
PreprocessBuildRule.prototype.build = function (builder)
{
    if (!PreprocessBuildRule.prototype.__build) {
        // Initialize static data.
        PreprocessBuildRule.prototype.__build = {
            "re_param": new RegExp("@(\\w+)@", "g")
        };
    }

    WScript.Echo("PREPROCESS: " + this.inNames[0] + " >> " + this.outNames[0]);
    var datIn = WScript.CreateObject("ADODB.Stream");
    datIn.Open();
    try {
        // Load input file.
        datIn.Type = adTypeText;
        datIn.Charset = this.inCharset;
        datIn.LineSeparator = this.inLineSep;
        datIn.LoadFromFile(this.inNames[0]);

        var datOut = WScript.CreateObject("ADODB.Stream");
        datOut.Open();
        try {
            datOut.Type = adTypeText;
            datOut.Charset = this.outCharset;
            datOut.LineSeparator = this.outLineSep;


            var dict = this.ver.define;
            while (!datIn.EOS) {
                datOut.WriteText(datIn.ReadText(adReadLine).replace(PreprocessBuildRule.prototype.__build.re_param, function ($0, $1) {
                    return $1 in dict ? dict[$1] : "@" + $1 + "@";
                }), adWriteLine);
            }

            // Persist stream to file.
            datOut.SaveToFile(this.outNames[0], adSaveCreateOverWrite);
        } finally {
            datOut.Close();
        }
    } finally {
        datIn.Close();
    }

    BuildRule.prototype.build.call(this, builder);
}


/**
 * Removes all output files
 * 
 * @param builder  The builder object
 */
PreprocessBuildRule.prototype.clean = BuildRule.prototype.clean;


/**
 * Creates a WiX compiler build rule
 * 
 * @param outName   Output .wixobj file name
 * @param inName    Input .wxs file name
 * @param depNames  Additional dependencies
 * @param flags     Additional WiX Candle flags
 *
 * @returns  Build rule
 */
function WiXCompileBuildRule(outName, inName, depNames, flags)
{
    this.flags = flags;

    return BuildRule.call(this, [outName], [inName].concat(depNames));
}


/**
 * Builds the rule
 * 
 * @param builder  The builder object
 */
WiXCompileBuildRule.prototype.build = function (builder)
{
    // Compile .wxs file.
    if (builder.exec(
        "\"" + builder.wixPath + "bin\\candle.exe\" " +
        builder.wixCandleFlags.join(" ") + (this.flags && this.flags.length ? " " + this.flags.join(" ") : "") +
        " -out \"" + this.outNames[0] + "\" \"" + this.inNames[0] + "\"") != 0)
        throw new Error("WiX compiler returned non-zero.");

    BuildRule.prototype.build.call(this, builder);
}


/**
 * Removes all output files
 * 
 * @param builder  The builder object
 */
WiXCompileBuildRule.prototype.clean = BuildRule.prototype.clean;


/**
 * Creates a WiX linker build rule
 * 
 * @param outName   Output .msi file name
 * @param inNames   Input .wixobj file names
 * @param depNames  Additional dependencies
 * @param flags     Additional WiX Light flags
 *
 * @returns  Build rule
 */
function WiXLinkBuildRule(outName, inNames, depNames, flags)
{
    this.flags = flags;
    this.objNames = inNames;

    return BuildRule.call(this, [outName], inNames.concat(depNames));
}


/**
 * Builds the rule
 * 
 * @param builder  The builder object
 */
WiXLinkBuildRule.prototype.build = function (builder)
{
    // Link .wixobj files.
    if (builder.exec(
        "\"" + builder.wixPath + "bin\\light.exe\" " +
        builder.wixLightFlags.join(" ") + (this.flags && this.flags.length ? " " + this.flags.join(" ") : "") +
        " -out \"" + this.outNames[0] + "\" \"" + this.objNames.join("\" \"") + "\"") != 0)
        throw new Error("WiX linker returned non-zero.");

    BuildRule.prototype.build.call(this, builder);
}


/**
 * Removes all output files
 * 
 * @param builder  The builder object
 */
WiXLinkBuildRule.prototype.clean = BuildRule.prototype.clean;

/*@end @*/
