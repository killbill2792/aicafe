import {renderToStaticMarkup} from "react-dom/server";
import {describe,expect,it} from "vitest";
import EventMapLink,{eventMapSearchUrl} from "./EventMapLink";

describe("saved event venue Maps link",()=>{
  it("opens a Google Maps search for the saved address, not a guessed distance",()=>{
    expect(eventMapSearchUrl(" 123 Market St, San Francisco, CA ")).toBe(
      "https://www.google.com/maps/search/?api=1&query=123%20Market%20St%2C%20San%20Francisco%2C%20CA");
    expect(eventMapSearchUrl("Calle Mayor 4, Madrid")).toContain(
      "query=Calle%20Mayor%204%2C%20Madrid");
  });
  it("renders a keyboard-accessible external link with the address and localized label",()=>{
    const markup=renderToStaticMarkup(
      <EventMapLink address="123 Market St, SF" label="Ver dirección en Maps"/>);
    expect(markup).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=123%20Market%20St%2C%20SF"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('Ver dirección en Maps');
    expect(markup).toContain('123 Market St, SF');
    expect(markup).toContain('min-h-12');
  });
  it("never produces an address link when the saved venue address is absent or malformed",()=>{
    for(const address of [null,"","  ","line\nbreak"]){
      expect(eventMapSearchUrl(address)).toBeNull();
      expect(renderToStaticMarkup(<EventMapLink address={address} label="View in Maps"/>)).toBe("");
    }
  });
  it("encodes untrusted address text inside a fixed Maps URL, never as an external host",()=>{
    const href=eventMapSearchUrl("https://not-maps.example/?x=<script>");
    expect(href).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
    expect(href).toContain("not-maps.example");
    expect(href).not.toContain("<script>");
  });
});
