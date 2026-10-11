'use strict';
/**
 * One prompt helper for every tool in this bundle.
 *
 * Why it is not just `readline.question`: when stdin is a pipe or a file
 * (scripted runs, `echo 0 | tools\rescue\dsh-config.cmd`) readline does not keep the event
 * loop alive, so Node exits silently in the middle of a multi-question flow
 * after the first answer. A non-TTY stdin is therefore read up front and
 * answered from memory; a real console still gets normal line editing.
 */
const fs = require('fs');
const readline = require('readline');

let RL = null;
let LINES = null;
let IDX = 0;

function ask(question) {
  if (!process.stdin.isTTY) {
    if (LINES === null) {
      let raw = '';
      try { raw = fs.readFileSync(0, 'utf8'); } catch (e) { raw = ''; }
      LINES = raw.replace(/\r\n/g, '\n').split('\n');
    }
    const answer = LINES[IDX++] || '';
    process.stdout.write(question + answer + '\n');
    return Promise.resolve(answer.trim());
  }
  return new Promise((resolve) => {
    if (!RL) RL = readline.createInterface({ input: process.stdin, output: process.stdout });
    RL.question(question, (a) => resolve(a.trim()));
  });
}

function close() {
  if (RL) { RL.close(); RL = null; }
}

module.exports = { ask, close };
