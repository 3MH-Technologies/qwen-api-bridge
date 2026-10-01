/**
 * Tool builder: turns the route registry into callable tools.
 *
 * One tool per route, grouped by namespace. Each tool exposes
 * `.name`, `.description`, `.schema` and `.invoke(client, args)`.
 */
import { ROUTES, GROUPS, HOSTS, routeUrl, toolName, isGuarded } from "../routes.js";

function schemaFor(route) {
  const properties = {};
  const required = [];
  if (route.params) {
    for (const [k, t] of Object.entries(route.params)) {
      properties[k] = { type: t.replace("?", "") };
      if (!t.endsWith("?")) required.push(k);
    }
  }
  if (route.query) {
    for (const [k, t] of Object.entries(route.query)) {
      properties[k] = { type: t.replace("?", "") };
    }
  }
  if (route.body) {
    for (const [k, t] of Object.entries(route.body)) {
      properties[k] = { type: t.replace("?", "").replace("object", "object") };
      if (!t.endsWith("?")) required.push(k);
    }
  }
  return { type: "object", properties, required, additionalProperties: true };
}

export function buildTool(route) {
  return {
    name: toolName(route),
    description: route.desc,
    group: route.group,
    method: route.method,
    path: GROUPS[route.group].prefix + route.path,
    url: (args = {}) => {
      const { params, query, ...rest } = args || {};
      const flat = { ...rest, ...(params || {}) };
      try {
        return routeUrl(route, { params: flat, query: query || {} });
      } catch {
        // No params supplied: show the template with readable placeholders.
        const g = GROUPS[route.group];
        return (
          HOSTS[g.host] +
          g.prefix +
          route.path.replace(/:([a-z_]+)/g, "{$1}")
        );
      }
    },
    stream: Boolean(route.stream),
    verified: Boolean(route.verified),
    /** Site's checkApiPath() would wrap this path with a challenge. */
    guarded: isGuarded(route),
    schema: schemaFor(route),

    async invoke(client, args = {}, opts = {}) {
      if (route.stream) {
        const events = [];
        for await (const ev of client.stream(route, args, opts)) events.push(ev);
        return events;
      }
      const res = await client.call(route, args, opts);
      return res.data;
    },
  };
}

/** All tools, keyed by name. */
export function buildAllTools(routes = ROUTES) {
  const tools = {};
  for (const route of routes) tools[toolName(route)] = buildTool(route);
  return tools;
}

/** A flat, model readable manifest of every tool. */
export function toolsManifest(routes = ROUTES) {
  return routes.map((route) => {
    const t = buildTool(route);
    return {
      name: t.name,
      description: t.description,
      method: t.method,
      url: t.url(),
      stream: t.stream,
      verified: t.verified,
      guarded: t.guarded,
      schema: t.schema,
    };
  });
}