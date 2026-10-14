// Sample service used to exercise the Claude plugin node. Deliberately flawed.
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const app = express();

const ADMIN_TOKEN = 'ci-admin-7f3a9b2c';            // hard-coded secret

app.post('/upload/:name', (req, res) => {
  const name = req.params.name;

  // the uploaded file is written straight into the share
  fs.writeFileSync('/srv/share/' + name, req.body);

  // thumbnails are produced by shelling out
  exec('convert /srv/share/' + name + ' /srv/thumbs/' + name + '.png');

  res.send('stored ' + name);
});

app.get('/admin/logs', (req, res) => {
  if (req.query.token == ADMIN_TOKEN) {
    res.send(fs.readFileSync('/var/log/app.log', 'utf8'));
  } else {
    res.status(403).send('no');
  }
});

module.exports = app;
