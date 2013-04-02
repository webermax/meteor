var path = require('path');
var _ = require('underscore');
var files = require('./files.js');
var warehouse = require('./warehouse.js');
var meteorNpm = require('./meteor_npm.js');
var fs = require('fs');

// Under the hood, packages in the library (/package/foo), and user
// applications, are both Packages -- they are just represented
// differently on disk.
//
// To create a package object from a package in the library:
//   var pkg = new Package;
//   pkg.init_from_library(name);
//
// To create a package object from an app directory:
//   var pkg = new Package;
//   pkg.initFromAppDir(app_dir, ignore_files, packageSearchOptions);

var next_package_id = 1;
var Package = function () {
  var self = this;

  // Fields set by init_*:
  // name: package name, or null for an app pseudo-package or collection
  // source_root: base directory for resolving source files, null for collection
  // serve_root: base directory for serving files, null for collection

  // A unique ID (guaranteed to not be reused in this process -- if
  // the package is reloaded, it will get a different id the second
  // time)
  self.id = next_package_id++;

  // package metadata, from describe()
  self.metadata = {};

  self.roleHandlers = {use: null, test: null};
  self.npmDependencies = null;

  // registered source file handlers
  self.extensions = {};

  // Packages used. Map from role to where to array of package name
  // (string.) The ordering in the array is significant only for
  // determining import symbol priority (it doesn't affect load
  // order.) A given package name should occur only once in a given
  // array.
  self.uses = {use: {client: [], server: []},
               test: {client: [], server: []}};

  // packages dependencies against which we are unordered (we don't
  // mind if they load after us, as long as they load.) map from
  // package name to true.
  self.unordered = {};

  // Files that we want to monitor for changes in development mode,
  // such as source files and package.js. Array of relative paths.
  self.dependencies = [];

  // All symbols exported from the JavaScript code in this
  // package. Map from role to where to array of string symbol (eg
  // "Foo", "Bar.baz".)
  self.exports = {use: {client: [], server: []},
                  test: {client: [], server: []}};

  // Prelink output. 'boundary' is a magic cookie used for inserting
  // imports. 'prelinkFiles' is the partially linked JavaScript
  // code. Both of these are inputs into the final link phase, which
  // inserts the final JavaScript resources into 'resources'. All of
  // them are maps from role to where to the actual value.
  self.boundary = {use: {client: null, server: null},
                   test: {client: null, server: null}};
  self.prelinkFiles = {use: {client: null, server: null},
                       test: {client: null, server: null}};

  // All of the data provided by this package for eventual inclusion
  // in the bundle, other than JavaScript that still needs to be fed
  // through the final link stage.. A map from where to role to a list
  // of objects with these keys:
  //
  // type: "js", "css", "head", "body", "static"
  //
  // data: The contents of this resource, as a Buffer. For example,
  // for "head", the data to insert in <head>; for "js", the
  // JavaScript source code (which may be subject to further
  // processing such as minification); for "static", the contents of a
  // static resource such as an image.
  //
  // servePath: The (absolute) path at which the resource would prefer
  // to be served. Interpretation varies by type. For example, always
  // honored for "static", ignored for "head" and "body", sometimes
  // honored for CSS but ignored if we are concatenating.
  self.resources = {use: {client: null, server: null},
                    test: {client: null, server: null}};

  // functions that can be called when the package is scanned --
  // visible as `Package` when package.js is executed
  self.packageFacade = {
    // keys
    // - summary: for 'meteor list'
    // - internal: if true, hide in list
    // - environments: optional
    //   (1) if present, if depended on in an environment not on this
    //       list, then throw an error
    //   (2) if present, these are also the environments that will be
    //       used when an application uses the package (since it can't
    //       specify environments.) if not present, apps will use
    //       [''], which is suitable for a package that doesn't care
    //       where it's loaded (like livedata.)
    describe: function (metadata) {
      _.extend(self.metadata, metadata);
    },

    on_use: function (f) {
      if (self.roleHandlers.use)
        throw new Error("A package may have only one on_use handler");
      self.roleHandlers.use = f;
    },

    on_test: function (f) {
      if (self.roleHandlers.test)
        throw new Error("A package may have only one on_test handler");
      self.roleHandlers.test = f;
    },

    register_extension: function (extension, callback) {
      if (_.has(self.extensions, extension))
        throw new Error("This package has already registered a handler for " +
                        extension);
      self.extensions[extension] = callback;
    },

    // Same as node's default `require` but is relative to the
    // package's directory. Regular `require` doesn't work well
    // because we read the package.js file and `runInThisContext` it
    // separately as a string.  This means that paths are relative to
    // the top-level meteor.js script rather than the location of
    // package.js
    _require: function(filename) {
      return require(path.join(self.source_root, filename));
    }
  };

  // npm functions that can be called when the package is scanned --
  // visible `Npm` when package.js is executed
  self.npmFacade = {
    depends: function (npmDependencies) {
      if (self.npmDependencies)
        throw new Error("Can only call `Npm.depends` once in package " + self.name + ".");

      // don't allow npm fuzzy versions so that there is complete
      // consistency when deploying a meteor app
      //
      // XXX use something like seal or lockdown to have *complete* confidence
      // we're running the same code?
      meteorNpm.ensureOnlyExactVersions(npmDependencies);

      self.npmDependencies = npmDependencies;
    },

    require: function (name) {
      var nodeModuleDir = path.join(self.source_root, '.npm', 'node_modules', name);
      if (fs.existsSync(nodeModuleDir)) {
        return require(nodeModuleDir);
      } else {
        try {
          return require(name); // from the dev bundle
        } catch (e) {
          throw new Error("Can't find npm module '" + name + "'. Did you forget to call 'Npm.depends'?");
        }
      }
    }
  };

};

_.extend(Package.prototype, {
  // loads a package's package.js file into memory, using
  // runInThisContext. Wraps the contents of package.js in a closure,
  // supplying pseudo-globals 'Package' and 'Npm'.
  initFromPackageDir: function (name, dir) {
    var self = this;
    self.name = name;
    self.source_root = dir;
    self.serve_root = path.join(path.sep, 'packages', name);

    if (!fs.existsSync(self.source_root))
      throw new Error("The package named " + self.name + " does not exist.");

    // We use string concatenation to load package.js rather than
    // directly `require`ing it because that allows us to simplify the
    // package API (such as supporting Package.on_use rather than
    // something like Package.current().on_use)

    var fullpath = path.join(self.source_root, 'package.js');
    var code = fs.readFileSync(fullpath).toString();
    // \n is necessary in case final line is a //-comment
    var wrapped = "(function(Package,Npm){" + code + "\n})";
    // See #runInThisContext
    //
    // XXX it'd be nice to runInNewContext so that the package
    // setup code can't mess with our globals, but objects that
    // come out of runInNewContext have bizarro antimatter
    // prototype chains and break 'instanceof Array'. for now,
    // steer clear
    var func = require('vm').runInThisContext(wrapped, fullpath, true);
    func(self.packageFacade, self.npmFacade);

    self.dependencies.push('package.js');

    // source files used
    var sources = {use: {client: [], server: []},
                   test: {client: [], server: []}};

    // symbols force-exported
    var forceExport = {use: {client: [], server: []},
                       test: {client: [], server: []}};

    // For this old-style, on_use/on_test/where-based package, figure
    // out its dependencies by calling its on_xxx functions and seeing
    // what it does.
    //
    // We have a simple strategy. Call its on_xxx handler with no
    // 'where', which is what happens when the package is added
    // directly to an app, and see what files it adds to the client
    // and the server. Call the former the client version of the
    // package, and the latter the server version. Then, when a
    // package is used, include it in both the client and the server
    // by default. This simple strategy doesn't capture even 10% of
    // the complexity possible with on_use, on_test, and where, but
    // probably is sufficient for virtually all packages that actually
    // exist in the field, if not every single
    // one. #OldStylePackageSupport
    _.each(["use", "test"], function (role) {
      if (self.roleHandlers[role]) {
        self.roleHandlers[role]({
          // Called when this package wants to make another package be
          // used. Can also take literal package objects, if you have
          // anonymous packages you want to use (eg, app packages)
          //
          // options can include:
          //
          // - role: defaults to "use", but you could pass something
          //   like "test" if for some reason you wanted to include a
          //   package's tests
          //
          // - unordered: if true, don't require this package to load
          //   before us -- just require it to be loaded anytime. Also
          //   don't bring this package's imports into our
          //   namespace. If false, override a true value specified in
          //   a previous call to use for this package name. (A
          //   limitation of the current implementation is that this
          //   flag is not tracked per-environment or per-role.)  This
          //   option can be used to resolve circular dependencies in
          //   exceptional circumstances, eg, the 'meteor' package
          //   depends on 'handlebars', but all packages (including
          //   'handlebars') have an implicit dependency on
          //   'meteor'. Internal use only -- future support of this
          //   is not guaranteed. #UnorderedPackageReferences
          use: function (names, where, options) {
            options = options || {};

            if (!(names instanceof Array))
              names = names ? [names] : [];

            if (!(where instanceof Array))
              where = where ? [where] : ["client", "server"];

            _.each(names, function (name) {
              _.each(where, function (w) {
                if (options.role && options.role !== "use")
                  throw new Error("Role override is no longer supported");
                self.uses[role][w].push(name);
                if (options.unordered)
                  self.unordered[name] = true;
              });
            });
          },

          // Top-level call to add a source file to a package. It will
          // be processed according to its extension (eg, *.coffee
          // files will be compiled to JavaScript.)
          add_files: function (paths, where) {
            if (!(paths instanceof Array))
              paths = paths ? [paths] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(paths, function (path) {
              _.each(where, function (w) {
                sources[role][w].push(path);
              });
            });
          },

          // Force the export of a symbol from this package. An
          // alternative to using @export directives. Possibly helpful
          // when you don't want to modify the source code of a third
          // party library.
          //
          // @param symbols String (eg "Foo", "Foo.bar") or array of String
          // @param where 'client', 'server', or an array of those
          exportSymbol: function (symbols, where) {
            if (!(symbols instanceof Array))
              symbols = symbols ? [symbols] : [];

            if (!(where instanceof Array))
              where = where ? [where] : [];

            _.each(symbols, function (symbol) {
              _.each(where, function (w) {
                forceExport[role][w].push(symbol);
              });
            });
          },
          error: function () {
            throw new Error("api.error(), ironically, is no longer supported");
          },
          registered_extensions: function () {
            throw new Error("api.registered_extensions() is no longer supported");
          }
        });
      }
    });

    // Also, everything depends on the package 'meteor', which sets up
    // the basic environment) (except 'meteor' itself)
    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        if (! (name === "meteor" && role === "use"))
          self.uses[role][where].unshift("meteor");
      });
    });

    self._uniquifyPackages();
    self._compile(sources, forceExport);
  },

  // If a package appears twice in a 'self.uses' list, keep only the
  // rightmost instance.
  _uniquifyPackages: function () {
    var self = this;

    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        var input = self.uses[role][where];
        var output = [];

        var seen = {};
        for (var i = input.length - 1; i >= 0; i--) {
          if (! seen[input[i]])
            output.unshift(input[i]);
          seen[input[i]] = true;
        }

        self.uses[role][where] = output;
      });
    });
  },

  // @returns {Boolean} was the package found in the app's packages/
  // directory?
  initFromAppPackages: function (name, appDir) {
    var packageDirInApp = path.join(appDir, 'packages', name);
    if (files.is_package_dir(packageDirInApp)) {
      this.initFromPackageDir(name, packageDirInApp);
      return true;
    } else {
      return false;
    }
  },

  // Searches:
  // - $PACKAGE_DIRS (colon-separated)
  // - $METEOR/packages
  // @returns {Boolean} was the package found in any local package sets?
  initFromLocalPackages: function (name) {
    var packageDir = packages.directoryForLocalPackage(name);
    if (packageDir) {
      this.initFromPackageDir(name, packageDir);
      return true;
    } else {
      return false;
    }
  },

  initFromWarehouse: function (name, version) {
    this.initFromPackageDir(
      name,
      path.join(warehouse.getWarehouseDir(), 'packages', name, version));
  },

  initFromAppDir: function (app_dir, ignore_files, packageSearchOptions) {
    var self = this;
    self.name = null;
    self.source_root = app_dir;
    self.serve_root = path.sep;

    var sources_except = function (role, where, except, tests) {
      var allSources = self._scan_for_sources(role, where, ignore_files || [],
                                              packageSearchOptions);
      var withoutAppPackages = _.reject(allSources, function (sourcePath) {
        // Skip files that are in app packages. (Directories named "packages"
        // lower in the tree are OK.)
        return sourcePath.match(/^packages\//);
      });
      var withoutExceptDir = _.reject(withoutAppPackages, function (source_path) {
        return (path.sep + source_path + path.sep).indexOf(path.sep + except + path.sep) !== -1;
      });
      return _.filter(withoutExceptDir, function (source_path) {
        var is_test = ((path.sep + source_path + path.sep).indexOf(path.sep + 'tests' + path.sep) !== -1);
        return is_test === (!!tests);
      });
    };

    // standard client packages (for now), for the classic meteor
    // stack.
    // XXX remove and make everyone explicitly declare all dependencies
    var packages = ['meteor', 'deps', 'session', 'livedata', 'mongo-livedata',
                    'spark', 'templating', 'startup', 'past'];
    packages =
      _.union(packages,
              require(path.join(__dirname, 'project.js')).
              get_packages(app_dir));

    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        // Note that technically to match the historical behavior, we
        // should include a dependency of the 'test' role of the
        // package on the 'use' role. But we don't have a way to do
        // that, since these are strings and this package is
        // anonymous. But this shouldn't matter since this form of app
        // testing never actually shipped.
        self.uses[role][where] = packages;
      });
    });
    self._uniquifyPackages();

    var sources = {
      use: {
        client: sources_except("use", "client", "server"),
        server: sources_except("use", "server", "client")
      }, test: {
        client: sources_except("test", "client", "server", true),
        server: sources_except("test", "server", "client", true)
      }
    };

    self._compile(sources, {use: {client: [], server: []},
                            test: {client: [], server: []}});
  },

  // sources is a map from role to where to an array of source
  // files. Process all source files through the appropriate handlers
  // and run the prelink phase on any resulting JavaScript. Also add
  // all provided source files to the package
  // dependencies. forceExport is a the symbols that the package wants
  // to export even if they are not declared in @export in the source,
  // and is in the same format as self.exports.
  _compile: function (sources, forceExport) {
    var self = this;
    var allSources = {};
    var isApp = ! self.name;

    _.each(["use", "test"], function (role) {
      _.each(["client", "server"], function (where) {
        var resources = [];
        var js = [];

        /**
         * In the legacy extension API, this is the ultimate low-level
         * entry point to add data to the bundle.
         *
         * type: "js", "css", "head", "body", "static"
         *
         * path: the (absolute) path at which the file will be
         * served. ignored in the case of "head" and "body".
         *
         * source_file: the absolute path to read the data from. if
         * path is set, will default based on that. overridden by
         * data.
         *
         * data: the data to send. overrides source_file if
         * present. you must still set path (except for "head" and
         * "body".)
         */
        var add_resource = function (options) {
          var source_file = options.source_file || options.path;

          var data;
          if (options.data) {
            data = options.data;
            if (!(data instanceof Buffer)) {
              if (!(typeof data === "string"))
                throw new Error("Bad type for data");
              data = new Buffer(data, 'utf8');
            }
          } else {
            if (!source_file)
              throw new Error("Need either source_file or data");
            data = fs.readFileSync(source_file);
          }

          if (options.where && options.where !== slice.where)
            throw new Error("'where' is deprecated here and if provided " +
                            "must be '" + slice.where + "'");

          (type === "js" ? js : resources).push({
            type: options.type,
            data: data,
            servePath: options.path
          });
        };

        _.each(sources[slice.role][slice.where], function (relPath) {
          allSources[source] = true;

          var ext = path.extname(relPath).substr(1);
          // XXX XXX XXX MUST PASS packageSearchOptions
          var handler = self._getSourceHandler(slice.role, slice.where, ext,
                                               /*self.packageSearchOptions*/);
          if (! handler) {
            // If we don't have an extension handler, serve this file
            // as a static resource.
            resources.push({
              type: "static",
              data: fs.readFileSync(path.join(slice.pkg.source_root, relPath)),
              servePath: path.join(slice.pkg.serve_root, relPath)
            });
            return;
          }

          handler({add_resource: add_resource},
                  path.join(slice.pkg.source_root, relPath),
                  path.join(slice.pkg.serve_root, relPath),
                  slice.where);
        });

        // Phase 1 link
        var servePathForRole = {
          use: "/packages/",
          test: "/package-tests/"
        };

        var results = linker.prelink({
          inputFiles: inputs,
          useGlobalNamespace: isApp,
          combinedServePath: isApp ? null :
            servePathForRole[role] + self.name + ".js",
          // XXX report an error if there is a package called global-imports
          importStubServePath: '/packages/global-imports.js',
          name: self.name || null,
          forceExport: forceExport[role][where]
        });

        self.prelinkFiles[role][where] = results.files;
        self.boundary[role][where] = results.boundary;
        self.exports[role][where] = results.exports
      });
    });

    self.dependencies = _.union(self.dependencies, _.keys(allSources));
  },

  // Find all files under this.source_root that have an extension we
  // recognize, and return them as a list of paths relative to
  // source_root. Ignore files that match a regexp in the ignore_files
  // array, if given. As a special case (ugh), push all html files to
  // the head of the list.
  //
  // role should be 'use' or 'test'
  // where should be 'client' or 'server'
  _scan_for_sources: function (role, where, ignore_files,
                               packageSearchOptions) {
    var self = this;

    // find everything in tree, sorted depth-first alphabetically.
    var file_list =
      files.file_list_sync(self.source_root,
                           self.registeredExtensions(role, where,
                                                     packageSearchOptions));
    file_list = _.reject(file_list, function (file) {
      return _.any(ignore_files || [], function (pattern) {
        return file.match(pattern);
      });
    });
    file_list.sort(files.sort);

    // XXX HUGE HACK --
    // push html (template) files ahead of everything else. this is
    // important because the user wants to be able to say
    // Template.foo.events = { ... }
    //
    // maybe all of the templates should go in one file? packages
    // should probably have a way to request this treatment (load
    // order depedency tags?) .. who knows.
    var htmls = [];
    _.each(file_list, function (filename) {
      if (path.extname(filename) === '.html') {
        htmls.push(filename);
        file_list = _.reject(file_list, function (f) { return f === filename;});
      }
    });
    file_list = htmls.concat(file_list);

    // now make everything relative to source_root
    var prefix = self.source_root;
    if (prefix[prefix.length - 1] !== path.sep)
      prefix += path.sep;

    return file_list.map(function (abs) {
      if (path.relative(prefix, abs).match(/\.\./))
        // XXX audit to make sure it works in all possible symlink
        // scenarios
        throw new Error("internal error: source file outside of parent?");
      return abs.substr(prefix.length);
    });
  },

  // Called when this package wants to ensure certain npm dependencies
  // are installed for use within server code.
  //
  // @param npmDependencies {Object} eg {gcd: "0.0.0", tar: "0.1.14"}
  installNpmDependencies: function(quiet) {
    if (this.npmDependencies) {
      // go through a specialized npm dependencies update process, ensuring
      // we don't get new versions of any (sub)dependencies. this process
      // also runs safely multiple times in parallel (which could happen if you
      // have two apps running locally using the same package)
      meteorNpm.updateDependencies(this.name, this.npmDir(), this.npmDependencies, quiet);
    }
  },

  npmDir: function () {
    return path.join(this.source_root, '.npm');
  },

  // Return a list of all of the extension that indicate source files
  // inside this package, INCLUDING leading dots. Computed based on
  // this.uses, so should only be called once that has been set.
  //
  // 'role' should be 'use' or 'test'. 'where' should be 'client' or 'server'.
  registeredExtensions: function (role, where, packageSearchOptions) {
    var self = this;
    var ret = _.keys(self.extensions);

    _.each(self.uses[role][where], function (pkgName) {
      var pkg = packages.get(pkgName, packageSearchOptions);
      ret = _.union(ret, _.keys(pkg.extensions));
    });

    return _.map(ret, function (x) {return "." + x;});
  },

  // Find the function that should be used to handle a source file
  // found in this package. We'll use handlers that are defined in
  // this package and in its immediate dependencies. ('extension'
  // should be the extension of the file without a leading dot.)
  _getSourceHandler: function (role, where, extension, packageSearchOptions) {
    var self = this;
    var candidates = [];

    if (role === "use" && extension in self.extensions)
      candidates.push(self.extensions[extension]);

    var seen = {};
    _.each(self.uses[role][where], function (pkgName) {
      var otherPkg = packages.get(pkgName, packageSearchOptions);
      if (extension in otherPkg.extensions)
        candidates.push(otherPkg.extensions[extension]);
    });

    // XXX do something more graceful than printing a stack trace and
    // exiting!! we have higher standards than that!

    if (!candidates.length)
      return null;

    if (candidates.length > 1)
      // XXX improve error message (eg, name the packages involved)
      // and make it clear that it's not a global conflict, but just
      // among this package's dependencies
      throw new Error("Conflict: two packages are both trying " +
                      "to handle ." + extension);

    return candidates[0];
  }
});

var loadedPackages = {};

var packages = module.exports = {

  // get a package by name. also maps package objects to themselves.
  // load order is:
  // - APP_DIR/packages (if options.appDir passed)
  // - PACKAGE_DIRS
  // - METEOR_DIR/packages (if in a git checkout)
  // - warehouse (if options.releaseManifest passed)
  get: function (name, options) {
    var self = this;
    options = options || {};
    if (name instanceof Package)
      return name;
    if (!(name in loadedPackages)) {
      var pkg = new Package;
      if (options.appDir && pkg.initFromAppPackages(name, options.appDir)) {
        loadedPackages[name] = pkg;
      } else if (pkg.initFromLocalPackages(name)) {
        loadedPackages[name] = pkg;
      } else if (options.releaseManifest) {
        pkg.initFromWarehouse(name, options.releaseManifest.packages[name]);
        loadedPackages[name] = pkg;
      }
    }

    return loadedPackages[name];
  },

  // load a package directly from a directory. don't cache.
  loadFromDir: function(name, packageDir) {
    var pkg = new Package;
    pkg.initFromPackageDir(name, packageDir);
    return pkg;
  },

  // get a package that represents an app. (ignore_files is optional
  // and if given, it should be an array of regexps for filenames to
  // ignore when scanning for source files.)
  get_for_app: function (app_dir, ignore_files, packageSearchOptions) {
    var pkg = new Package;
    pkg.initFromAppDir(app_dir, ignore_files || [], packageSearchOptions);
    return pkg;
  },

  // force reload of all packages
  flush: function () {
    loadedPackages = {};
  },

  // get all packages available. searches:
  // - local package sets
  // - warehouse (if we are passed a release manifest)
  //
  // returns {Object} maps name to Package
  list: function (releaseManifest) {
    var self = this;
    var list = {};

    _.each(self._localPackageDirs(), function (dir) {
      _.each(fs.readdirSync(dir), function (name) {
        if (files.is_package_dir(path.join(dir, name))) {
          if (!list[name]) // earlier directories get precedent
            list[name] = packages.get(name); // empty release manifest, we're loading from local packages
        }
      });
    });

    if (releaseManifest) {
      _.each(releaseManifest.packages, function(version, name) {
        // don't even look for packages if they've already been
        // overridden (though this `if` isn't necessary for
        // correctness, since `packages.get` looks for packages in the
        // override directories first anyways)
        if (!list[name])
          list[name] = packages.get(name, {releaseManifest: releaseManifest});
      });
    }

    return list;
  },

  // returns a pretty list suitable for showing to the user. input is
  // a list of package objects, each of which must have a name (not be
  // an application package.)
  format_list: function (pkgs) {
    var longest = '';
    _.each(pkgs, function (pkg) {
      if (pkg.name.length > longest.length)
        longest = pkg.name;
    });
    var pad = longest.replace(/./g, ' ');
    // it'd be nice to read the actual terminal width, but I tried
    // several methods and none of them work (COLUMNS isn't set in
    // node's environment; `tput cols` returns a constant 80.) maybe
    // node is doing something weird with ptys.
    var width = 80;

    var out = '';
    _.each(pkgs, function (pkg) {
      if (pkg.metadata.internal)
        return;
      var name = pkg.name + pad.substr(pkg.name.length);
      var summary = pkg.metadata.summary || 'No description';
      out += (name + "  " +
              summary.substr(0, width - 2 - pad.length) + "\n");
    });

    return out;
  },

  // for a packge that exists in localPackageDirs, find the directory
  // in which it exists
  directoryForLocalPackage: function(name) {
    var ret;
    _.find(this._localPackageDirs(), function(packageDir) {
      var dir = path.join(packageDir, name);
      if (fs.existsSync(path.join(dir, 'package.js'))) {
        ret = dir;
        return true;
      }
      return false; // make lint happy
    });

    return ret;
  },

  _localPackageDirs: function () {
    var packageDirs = [];
    if (!files.usesWarehouse())
      packageDirs.push(path.join(files.getCurrentEngineDir(), 'packages'));

    if (process.env.PACKAGE_DIRS)
      packageDirs = process.env.PACKAGE_DIRS.split(':').concat(packageDirs);
    return packageDirs;
  }
};