import {describe,expect,it} from "vitest";
import {eventActionAreaLabel,eventActionAreas} from "./eventActionArea";

describe("event readiness action area labels",()=>{
  it("localizes every saved enum for checklist and approval card presentations",()=>{
    expect(eventActionAreas).toEqual(["staff","prep","ordering","promo","hours","operations"]);
    expect(eventActionAreas.map(area=>eventActionAreaLabel(area,"en")))
      .toEqual(["Staff","Preparation","Ordering","Promotion","Opening hours","Operations"]);
    expect(eventActionAreas.map(area=>eventActionAreaLabel(area,"es")))
      .toEqual(["Personal","Preparación","Pedidos","Promoción","Horario de apertura","Operaciones"]);
    expect(eventActionAreas.map(area=>eventActionAreaLabel(area,"ar")))
      .toEqual(["الموظفون","التحضير","طلب المستلزمات","الترويج","ساعات العمل","العمليات"]);
  });
  it("never shows an unexpected backend enum to the owner",()=>{
    expect(eventActionAreaLabel("internal_new_area","en")).toBe("Other");
    expect(eventActionAreaLabel("internal_new_area","es")).toBe("Otro");
    expect(eventActionAreaLabel("internal_new_area","ar")).toBe("أخرى");
  });
});
