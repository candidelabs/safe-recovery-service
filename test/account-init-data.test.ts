// The option that governs what the service does with accounts that are not deployed yet (parseCounterfactualAccounts):
// no database, no chain, no app boot.
import {parseCounterfactualAccounts} from "../src/config/config-manager";

describe("parseCounterfactualAccounts", () => {
  const DEFAULTS = {erc6492: true, storeInitData: "never"};

  test.each([
    ["omitted", undefined],
    ["null", null],
    ["~", "~"],
    ["an empty object", {}],
  ])("reads %s as the defaults", (_name, value) => {
    expect(parseCounterfactualAccounts(value)).toEqual(DEFAULTS);
  });

  test("takes erc6492 as a boolean, or 'true' / 'false' in any case, and defaults it to true", () => {
    expect(parseCounterfactualAccounts({erc6492: false})).toEqual({erc6492: false, storeInitData: "never"});
    expect(parseCounterfactualAccounts({erc6492: true, storeInitData: "always"})).toEqual({erc6492: true, storeInitData: "always"});
    expect(parseCounterfactualAccounts({erc6492: "FALSE"})).toEqual({erc6492: false, storeInitData: "never"});
    expect(parseCounterfactualAccounts({erc6492: "True"})).toEqual(DEFAULTS);
    expect(parseCounterfactualAccounts({storeInitData: "with-guardian"})).toEqual({erc6492: true, storeInitData: "with-guardian"});
  });

  test.each(["never", "with-guardian", "always"])("takes storeInitData %s", (storeInitData) => {
    expect(parseCounterfactualAccounts({storeInitData})).toEqual({erc6492: true, storeInitData});
  });

  test.each([
    ["a string", "always", "Options.counterfactualAccounts must be an object with 'erc6492' and 'storeInitData', or '~'."],
    ["a list", [true], "Options.counterfactualAccounts must be an object with 'erc6492' and 'storeInitData', or '~'."],
    ["a number", 1, "Options.counterfactualAccounts must be an object with 'erc6492' and 'storeInitData', or '~'."],
    ["an unknown key", {erc6492: true, storeInitdata: "always"}, "Options.counterfactualAccounts has an unknown key 'storeInitdata'."],
    ["erc6492 as a number", {erc6492: 1}, "Options.counterfactualAccounts.erc6492 must be true or false."],
    ["erc6492 as another string", {erc6492: "yes"}, "Options.counterfactualAccounts.erc6492 must be true or false."],
    ["erc6492 as null", {erc6492: null}, "Options.counterfactualAccounts.erc6492 must be true or false."],
    ["storeInitData in another case", {storeInitData: "Always"}, "Options.counterfactualAccounts.storeInitData must be 'never', 'with-guardian' or 'always'."],
    ["storeInitData as a boolean", {storeInitData: true}, "Options.counterfactualAccounts.storeInitData must be 'never', 'with-guardian' or 'always'."],
    ["storeInitData with erc6492 off", {erc6492: false, storeInitData: "with-guardian"}, "Options.counterfactualAccounts.storeInitData must be 'never' when erc6492 is false."],
    ["storeInitData always with erc6492 'false'", {erc6492: "false", storeInitData: "always"}, "Options.counterfactualAccounts.storeInitData must be 'never' when erc6492 is false."],
  ])("refuses %s", (_name, value, message) => {
    expect(() => parseCounterfactualAccounts(value)).toThrow(message);
  });
});
