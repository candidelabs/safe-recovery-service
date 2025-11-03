module.exports = {
  preset: "ts-jest/presets/js-with-ts",
  testEnvironment: "node",
  testMatch: ["**/**/*.test.ts"],
  verbose: true,
  moduleDirectories: ["node_modules", "src"],
  forceExit: true,
  transformIgnorePatterns: ['/node_modules/(?!(ky))']
};