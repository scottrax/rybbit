import { describe, expect, it } from "vitest";

import posthogReactNativeReplay from "./__fixtures__/posthogReactNativeReplay.json";
import { transformMobileReplayEvents } from "./transformMobileReplayEvents";

const fixture = () => structuredClone(posthogReactNativeReplay);

function bodyChildren(event: any): any[] {
  return event.data.node.childNodes[1].childNodes[1].childNodes;
}

describe("transformMobileReplayEvents", () => {
  it("turns a PostHog React Native screenshot snapshot into an rrweb document", () => {
    const events = fixture();

    const transformed = transformMobileReplayEvents(events);

    expect(transformed[0]).toEqual({
      timestamp: 1725607643113,
      type: 4,
      data: { href: "", width: 393, height: 852 },
    });
    expect(transformed[1]).toMatchObject({
      timestamp: 1725607643113,
      type: 2,
      data: {
        initialOffset: { top: 0, left: 0 },
        node: { type: 0, id: 1 },
      },
    });

    const screenshot = bodyChildren(transformed[1]).find(node => node.attributes?.["data-posthog-screenshot"]);
    expect(screenshot).toMatchObject({
      type: 2,
      tagName: "img",
      id: 4324378400,
      attributes: {
        src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB",
        width: 393,
        height: 852,
        "data-posthog-screenshot": "true",
      },
    });
  });

  it("preserves touch events while targeting the generated body for id zero", () => {
    const transformed = transformMobileReplayEvents(fixture());

    expect(transformed[2]).toEqual({
      timestamp: 1725607643213,
      type: 3,
      data: { source: 2, type: 7, id: 5, x: 120, y: 240 },
    });
  });

  it("converts screenshot updates to rrweb remove-and-add mutations on the body", () => {
    const transformed = transformMobileReplayEvents(fixture());

    expect(transformed[3]).toMatchObject({
      timestamp: 1725607643313,
      type: 3,
      data: {
        source: 0,
        attributes: [],
        texts: [],
        removes: [{ parentId: 5, id: 4324378400 }],
        adds: [
          {
            parentId: 5,
            nextId: null,
            node: {
              type: 2,
              tagName: "img",
              id: 4324378400,
              attributes: {
                src: "data:image/webp;base64,UklGRg==",
                "data-posthog-screenshot": "true",
              },
            },
          },
        ],
      },
    });
  });

  it("converts keyboard custom events to rrweb mutations", () => {
    const transformed = transformMobileReplayEvents(fixture());

    expect(transformed[4]).toMatchObject({
      timestamp: 1725607643413,
      type: 3,
      data: {
        source: 0,
        adds: [
          {
            parentId: 9,
            nextId: null,
            node: {
              id: 10,
              type: 2,
              tagName: "div",
              attributes: { style: expect.stringContaining("data:image/svg+xml;base64") },
            },
          },
          {
            parentId: 10,
            nextId: null,
            node: { type: 3, textContent: "keyboard" },
          },
        ],
        removes: [],
      },
    });
    expect(transformed[5]).toEqual({
      timestamp: 1725607643513,
      type: 3,
      data: {
        source: 0,
        adds: [],
        attributes: [],
        removes: [{ parentId: 9, id: 10 }],
        texts: [],
      },
    });
  });

  it("does not transform or copy a normal web rrweb session", () => {
    const webEvents = [
      { timestamp: 1, type: 4, data: { href: "https://example.com", width: 1280, height: 720 } },
      { timestamp: 2, type: 2, data: { node: { id: 1, type: 0, childNodes: [] } } },
      { timestamp: 3, type: 3, data: { source: 2, type: 2, id: 0, x: 10, y: 20 } },
    ];

    expect(transformMobileReplayEvents(webEvents)).toBe(webEvents);
    expect(webEvents[2].data.id).toBe(0);
  });

  it("does not render remote background images from replay payloads", () => {
    const events = fixture();
    const screenshotWireframe = (events[1] as any).data.wireframes[0];
    screenshotWireframe.style = {
      backgroundImage: "url('https://attacker.example/tracking-pixel')",
    };

    const transformed = transformMobileReplayEvents(events);
    const screenshot = bodyChildren(transformed[1]).find(node => node.attributes?.["data-posthog-screenshot"]);

    expect(screenshot.attributes.style).not.toContain("attacker.example");
  });

  it("removes CSS delimiter injection from mobile style values", () => {
    const events = fixture();
    const screenshotWireframe = (events[1] as any).data.wireframes[0];
    screenshotWireframe.style = {
      backgroundColor: "red; background-image: url(https://attacker.example/pixel)",
    };

    const transformed = transformMobileReplayEvents(events);
    const screenshot = bodyChildren(transformed[1]).find(node => node.attributes?.["data-posthog-screenshot"]);

    expect(screenshot.attributes.style).not.toContain("attacker.example");
  });
});
