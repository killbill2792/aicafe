import {describe,it,expect} from "vitest";
import {resumeOwnerQuestion} from "./resume";
describe("owner fact card continuation",()=>{
 it("resumes a combined question with the full original request and entered facts",()=>{
  const original="What was profit last week and what should oat milk cost?";
  const message=resumeOwnerQuestion(original,"Saved",[
   {label:"Current milk cost",value:"0.40"},{label:"Oat milk cost",value:"0.90"}]);
  expect(message).toContain(original);
  expect(message).toContain("0.40");
  expect(message).toContain("0.90");
  expect(message).not.toBe("Saved");
 });
 it("keeps a localized acknowledgement without inventing a prior question",()=>{
  expect(resumeOwnerQuestion(null,"He guardado la respuesta",[])).toBe("He guardado la respuesta");
 });
});
