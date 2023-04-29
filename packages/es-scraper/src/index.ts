import "./polyfill.js";

import FS from "node:fs/promises";
import * as Cheerio from "cheerio";
import { generatedPath, assert } from "./utils.js";

type Section = {
  title: string;
  id: string;
  children: Section[];
};

type DataAttributes = `${"w" | ""}${"e" | ""}${"c" | ""}`;

type JSProperty =
  | {
      type: "data-property";
      name: string;
      attributes: DataAttributes;
    }
  | {
      type: "accessor-property";
      name: string;
      attributes: `${"g" | ""}${"s" | ""}${"e" | ""}${"c" | ""}`;
    };

type Parameters = { required: number; optional: number; rest: boolean };

type JSMethod = {
  type: "method";
  name: string;
  parameters: Parameters;
  attributes?: DataAttributes;
};

type JSConstructor = {
  type: "constructor";
  name: string;
  parameters: Parameters;
};

type JSNamespace = {
  type: "namespace";
  name: string;
  global: boolean;
  staticProperties: JSProperty[];
  staticMethods: JSMethod[];
};

type JSClass = {
  type: "class";
  name: string;
  global: boolean;
  constructor: JSConstructor | null;
  staticProperties: JSProperty[];
  staticMethods: JSMethod[];
  prototypeProperties: JSProperty[];
  instanceMethods: JSMethod[];
  instanceProperties: JSProperty[];
};

type JSGlobalProperty = {
  type: "global-property";
  name: string;
  attributes: `${"w" | ""}${"e" | ""}${"c" | ""}`;
};

type JSFunction = {
  type: "function";
  name: string;
  parameters: Parameters;
  global: boolean;
};

type JSGlobal = JSNamespace | JSClass | JSGlobalProperty | JSFunction;

const $ = await FS.readFile(generatedPath("spec.html")).then((content) =>
  Cheerio.load(content),
);

const typedArrayTypes = $("#table-the-typedarray-constructors dfn")
  .map((_, el) => $(el).text().replaceAll("%", ""))
  .get();

const errorTypes = $("#sec-native-error-types-used-in-this-standard dfn")
  .map((_, el) => $(el).text().replaceAll("%", ""))
  .get();

function buildTOC(root = $(":root > body")) {
  return root
    .children("emu-clause")
    .map((_, el): Section => {
      const subRoot = $(el);
      return {
        title: $(subRoot.children("h1").get()[0]!)
          .text()
          .replace(/[\s\n]+/gu, " ")
          .trim(),
        id: subRoot.attr("id")!,
        children: buildTOC(subRoot),
      };
    })
    .get();
}

function getBareSection(section: Section): Section {
  assert(
    section.children.every(
      (s) =>
        /^[A-Z][A-Za-z]+\s*\(|^`|Record$/u.test(s.title) &&
        s.children.length === 0,
    ) ||
      section.children.filter((s) => /^get |^set /.test(s.title)).length === 2,
    `Not all children are AOs/type-defs for ${section.title}`,
  );
  return section;
}

function parseParameters(title: string): [string, Parameters] {
  const { name, parameters } = title
    .replace(/(?<!,) /gu, "")
    .match(/(?<name>.*)\((?<parameters>.*)\)/u)!.groups!;
  const count = parameters!.split(",").length;
  const optional = parameters!.split("[").length - 1;
  const rest = parameters!.includes("...");
  return [
    `${name!}()`,
    { required: count - optional - Number(rest), optional, rest },
  ];
}

function makeMethod(s: Section): JSMethod {
  const attributes = getAttributes(s);
  const [name, parameters] = parseParameters(s.title);
  return {
    type: "method",
    name,
    parameters,
    ...(attributes ? { attributes } : undefined),
  };
}

function makeConstructor(s: Section | undefined): JSConstructor | null {
  if (!s) return null;
  const [name, parameters] = parseParameters(s.title);
  return {
    type: "constructor",
    name,
    parameters,
  };
}

function makeProperty(s: Section): JSProperty {
  if (s.children.filter((t) => /^get |^set /.test(t.title)).length === 2) {
    return {
      type: "accessor-property",
      name: s.title.replaceAll(" ", ""),
      attributes: "gsc",
    };
  } else if (/^get |^set /.test(s.title)) {
    return {
      type: "accessor-property",
      name: s.title.slice(4).replaceAll(" ", ""),
      attributes: `${/^get /.test(s.title) ? "g" : ""}${
        /^set /.test(s.title) ? "s" : ""
      }c`,
    };
  }
  return {
    type: "data-property",
    name: s.title.replaceAll(" ", ""),
    attributes: getAttributes(s) ?? "wc",
  };
}

function getAttributes(s: Section): DataAttributes | null {
  const paras = $(`#${s.id.replaceAll(/[.@]/g, "\\$&")} > p`)
    .filter((_, el) => $(el).text().includes("has the attributes"))
    .get();
  if (paras.length === 0) return null;
  assert(
    paras.length === 1,
    `Expected ${s.title} to have 1 attributes paragraph`,
  );
  const attributes = $(paras[0])
    .text()
    .match(
      /has the attributes \{ \[\[Writable\]\]: \*(?<writable>true|false)\*, \[\[Enumerable\]\]: \*(?<enumerable>true|false)\*, \[\[Configurable\]\]: \*(?<configurable>true|false)\* \}\./u,
    )!.groups!;
  return `${attributes.writable === "true" ? "w" : ""}${
    attributes.enumerable === "true" ? "e" : ""
  }${attributes.configurable === "true" ? "c" : ""}`;
}

const toc = buildTOC();
await FS.writeFile(generatedPath("toc.json"), JSON.stringify(toc, null, 2));
const objects = toc
  .slice(
    toc.findIndex((s) => s.title === "Fundamental Objects"),
    toc.findIndex((s) => s.title === "Reflection") + 1,
  )
  .flatMap((s) => s.children)
  .flatMap((s) => {
    if (s.title === "Error Objects") {
      const endOfError =
        s.children.findIndex(
          (t) => t.title === "Properties of Error Instances",
        ) + 1;
      const subItems = s.children.slice(endOfError, -1);
      const [nativeErrorTypes, nativeErrorStructure, ...otherErrors] = subItems;
      assert(
        nativeErrorTypes!.title === "Native Error Types Used in This Standard",
      );
      assert(nativeErrorStructure!.title === "_NativeError_ Object Structure");
      // The nativeErrorTypes are already extracted in errorTypes; they will be
      // backfilled later
      return [
        { title: s.title, id: s.id, children: s.children.slice(0, endOfError) },
        nativeErrorStructure!,
        ...otherErrors,
      ];
    } else if (s.title === "TypedArray Objects") {
      const endOfTA =
        s.children.findIndex(
          (t) => t.title === "Abstract Operations for TypedArray Objects",
        ) + 1;
      return [
        { title: s.title, id: s.id, children: s.children.slice(0, endOfTA) },
        {
          title: "_TypedArray_",
          id: s.id,
          children: s.children.slice(endOfTA),
        },
      ];
    } else if (s.title === "Object Objects") {
      const prototypeProps = s.children.findIndex(
        (t) => t.title === "Properties of the Object Prototype Object",
      );
      const prototypePropsSection = s.children[prototypeProps]!;
      return {
        title: s.title,
        children: s.children.toSpliced(prototypeProps, 1, {
          title: prototypePropsSection.title,
          id: prototypePropsSection.id,
          children: prototypePropsSection.children.flatMap((t) => {
            switch (t.title) {
              case "Legacy Object.prototype Accessor Methods":
                return t.children;
              default:
                return [t];
            }
          }),
        }),
      };
    } else if (s.title === "Iteration") {
      return [
        s.children.find((t) => t.title === "The %IteratorPrototype% Object")!,
        s.children.find(
          (t) => t.title === "The %AsyncIteratorPrototype% Object",
        )!,
      ];
    } else if (s.title === "Module Namespace Objects") {
      // No page for this
      return [];
    }
    return [s];
  })
  .map(({ title, children }): JSGlobal => {
    function getSubsections(pattern: RegExp) {
      return (
        children
          .find((c) => pattern.test(c.title))
          ?.children.map(getBareSection) ?? []
      );
    }

    if (title.endsWith("Object")) {
      let staticPropertySections = getSubsections(/Value Properties of/u);
      let staticMethodSections = getSubsections(/Function Properties of/u);
      assert(staticPropertySections.every((p) => !p.title.endsWith(")")));
      assert(staticMethodSections.every((p) => p.title.endsWith(")")));
      if (!staticPropertySections.length && !staticMethodSections.length) {
        const props = children.map(getBareSection);
        staticPropertySections = props.filter((p) => !p.title.endsWith(")"));
        staticMethodSections = props.filter((p) => p.title.endsWith(")"));
      }
      const staticProperties = staticPropertySections.map((s) =>
        makeProperty(s),
      );
      const staticMethods = staticMethodSections.map((s) => makeMethod(s));
      return {
        type: "namespace",
        name: title.replace(/^The | Object$/gu, ""),
        global: false,
        staticProperties,
        staticMethods,
      };
    }
    const staticPropSecs = getSubsections(/Properties of .* Constructor/u);
    const instancePropSecs = getSubsections(/Properties of .* Instances/u);
    const protoPropSecs = getSubsections(/Properties of .* Prototype Object/u);
    const ctorSection = children.find((c) =>
      /The .* Constructor/u.test(c.title),
    )?.children[0];
    assert(
      ctorSection?.title.endsWith(")") ?? true,
      "Constructor section does not specify constructor",
    );
    assert(instancePropSecs.every((p) => !p.title.endsWith(")")));
    function makeProperties(sections: Section[], method: false): JSProperty[];
    function makeProperties(sections: Section[], method: true): JSMethod[];
    function makeProperties(sections: Section[], method: boolean) {
      return sections
        .filter((p) => p.title.endsWith(")") === method)
        .map((s) => (method ? makeMethod : makeProperty)(s));
    }
    const staticProperties = makeProperties(staticPropSecs, false);
    const staticMethods = makeProperties(staticPropSecs, true);
    const prototypeProperties = makeProperties(protoPropSecs, false);
    const instanceMethods = makeProperties(protoPropSecs, true);
    const instanceProperties = instancePropSecs.map((s) => makeProperty(s));
    return {
      type: "class",
      name: title.replace(/ Objects| \(.*\)/gu, ""),
      global: false,
      constructor: makeConstructor(ctorSection),
      staticProperties,
      staticMethods,
      prototypeProperties,
      instanceMethods,
      instanceProperties,
    };
  })
  .flatMap((s) => {
    function expandAbstractClass(abstractName: string, name: string): JSGlobal {
      if (s.type !== "class") throw new Error("Not a class");
      const toExpand = [
        "staticProperties",
        "staticMethods",
        "prototypeProperties",
        "instanceMethods",
      ] as const;
      function expandSection<T extends { name: string }>(
        p: T | null,
      ): T | null {
        if (!p) return null;
        p = { ...p };
        p.name = p.name.replace(abstractName, name);
        return p;
      }
      return {
        type: "class",
        name,
        global: s.global,
        constructor: expandSection(s.constructor),
        ...(Object.fromEntries(
          toExpand.map((k) => [k, s[k].map(expandSection)]),
        ) as Pick<JSClass, (typeof toExpand)[number]>),
        instanceProperties: s.instanceProperties,
      };
    }
    if (s.type !== "class") return [s];
    if (s.name === "_TypedArray_")
      return typedArrayTypes.map((t) => expandAbstractClass("_TypedArray_", t));
    else if (s.name === "_NativeError_ Object Structure")
      return errorTypes.map((t) => expandAbstractClass("_NativeError_", t));
    return [s];
  });

const globals = toc.find((s) => s.title === "The Global Object")!.children;
assert(
  globals.length === 4 &&
    globals[0]!.title === "Value Properties of the Global Object" &&
    globals[1]!.title === "Function Properties of the Global Object" &&
    globals[2]!.title === "Constructor Properties of the Global Object" &&
    globals[3]!.title === "Other Properties of the Global Object",
  "Unexpected global object structure",
);
objects.push(
  ...globals[0]!.children.map((s) => {
    const section = getBareSection(s);
    return {
      type: "global-property" as const,
      name: section.title,
      attributes: getAttributes(section)!,
    };
  }),
  ...globals[1]!.children
    .map((s) =>
      (s.title === "URI Handling Functions"
        ? s.children.filter((t) => !/^[A-Z]/u.test(t.title))
        : [s]
      ).map((t) => {
        const [name, parameters] = parseParameters(getBareSection(t).title);
        return {
          type: "function" as const,
          name,
          parameters,
          global: true,
        };
      }),
    )
    .flat(2),
);
globals[2]!.children.forEach((s) => {
  const title = getBareSection(s).title.replace(" ( . . . )", "");
  const obj = objects.find((o) => o.name === title);
  assert(obj?.type === "class", `${title} is not a class`);
  obj.global = true;
});
globals[3]!.children.forEach((s) => {
  const title = getBareSection(s).title;
  const obj = objects.find((o) => o.name === title);
  assert(obj?.type === "namespace", `${title} is not a namespace`);
  obj.global = true;
});

await FS.writeFile(
  generatedPath("data.json"),
  JSON.stringify(objects, null, 2),
);
