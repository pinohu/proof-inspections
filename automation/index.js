"use strict";
/**
 * index.js — public surface of the automation layer.
 *
 * The backend API imports this module and wires the functions into HTTP
 * handlers. See README.md for the endpoint contract.
 */
const config = require("./config");
const store = require("./store");
const audit = require("./audit");
const dispatch = require("./dispatch");
const proof = require("./proof");
const report = require("./report");
const billing = require("./billing");
const lifecycle = require("./lifecycle");
const notify = require("./notify");

module.exports = {
  config,
  store,
  audit,
  dispatch,
  proof,
  report,
  billing,
  lifecycle,
  notify,
};
