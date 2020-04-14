#!/usr/bin/env node

/* jshint esversion: 6 */
/* jslint node: true */
/* global URL */ //Since Node v10
"use strict";

// Assumptions:
// docker installed & logged in
// ffplay installed in the host

const path = require('path');
const cp = require('child_process');
const fs = require('fs');

// Internal definitions
const DOCKER_CLIENT_NAME = 'client';
const DOCKER_CLIENT_MEDIA_VOLUME = '/media';

const containerids_to_clean = [DOCKER_CLIENT_NAME];

// Definitions
const cmd_docker = 'docker';

if ((process.argv.length < 6) && (process.argv[2] !== 'clean')) {
    console.log('Use ./start-simple-simulation.js PROTOCOL(rtmp, udp, str, fec, or clean) netemCmd TestDuration(s) MediaTestFile DestURL');
    console.log('Example: ./start-simple-simulation.js udp "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "udp://239.1.1.1:2000"');
    console.log('Example: ./start-simple-simulation.js rtmp "rate 10mbps loss 5% delay 200ms" 60 /test-video/test.ts "rtmps://myhost:2000/myStreamKey"');
    console.log('');
    console.log('Clean example: start-simulation.js clean (it wil make sure all previous containers are stopped');
    console.log('');
    console.log('For more info about netem command see: http://man7.org/linux/man-pages/man8/tc-netem.8.html');
    
    return 1;
}

if (process.argv[2] === 'clean') {
    cleanup(cmd_docker, containerids_to_clean, -1, DOCKER_NETWORK_NAME, FEC_CONFIG_FILE_NAME);
    return 0;
}

// Protocol
const protocol = process.argv[2];

// Netem CMD
const netem_cmd = process.argv[3];

// Test duration
const duration_s = parseInt(process.argv[4]);

// File
const media_file = process.argv[5];

// Destination URL
const dest_url = process.argv[6];

console.log(`Start test for protocol ${protocol}, URL: ${dest_url}, network (netem cmd): ${netem_cmd}`);

// Start client container
const client_args = ['run', '-d', '--cap-add=NET_ADMIN', '--name', `${DOCKER_CLIENT_NAME}`, '--rm', '-v', `${path.dirname(media_file)}:${DOCKER_CLIENT_MEDIA_VOLUME}`];

let ffmpeg_client_args = null;
if (protocol === 'rtmp') {
    client_args.push('jcenzano/docker-ffmpeg');

    ffmpeg_client_args = ['-re', '-stream_loop', '-1', '-i', path.join(DOCKER_CLIENT_MEDIA_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'flv', `${dest_url}`];
}

const client_ret = executeShell(cmd_docker, client_args.concat(ffmpeg_client_args));
if (checkExecError(cmd_docker, client_ret, containerids_to_clean) === true) {
    return 1;
}

if (netem_cmd !== '') {
    const netem_args = ['exec', DOCKER_CLIENT_NAME, 'sh', '-c', 'tc qdisc add dev eth0 root netem ' + netem_cmd];
    const netem_ret = executeShell(cmd_docker, netem_args);
    if (checkExecError(cmd_docker, netem_ret, containerids_to_clean) === true) {
        return 1;
    }
}

// Clean up after interference
setTimeout(cleanup, duration_s * 1000, cmd_docker, containerids_to_clean);

// Aux functions

function checkExecError(cmd_docker, ret, container_ids = [], pid = -1, network = null, fec_config_filename = null) {
    if ('error' in ret) {
        console.error(JSON.stringify(ret.error));
        return cleanup(cmd_docker, container_ids, pid, network, fec_config_filename);
    }
}

function cleanup(cmd_docker, container_ids) {
 
    container_ids.forEach(id => {
        const cmd_stop_args = ['stop', id];

        executeShell(cmd_docker, cmd_stop_args);
    });

    return;
}

function executeShell(cmd, args , async = false) {

    console.log(`Executing: ${cmd} ${args.join(' ')}`);

    let ret = null;
    if (async === false) {
        ret = cp.spawnSync(cmd, args);
    }
    else {
        ret = cp.exec(cmd + " " + args.join(' '));
    }
    
    if (!('error' in ret)) {
        console.log(`stderr: ${ret.stderr.toString()}`);
        console.log(`stdout: ${ret.stdout.toString()}`);
    }

    return ret;
}
