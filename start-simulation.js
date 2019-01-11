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

// Internal definitions
const DOCKER_CLIENT_NAME = 'client';
const DOCKER_CLIENT_VOLUME = '/media';
const DOCKER_REPEATER_NAME = 'repeater';
const DOCKER_TEST_PORT = 1935;
const REPEATER_HOST_PORT = 2010;

const DOCKER_NETWORK_NAME = "test-ingest-simulation";

const containerids_to_clean = [DOCKER_REPEATER_NAME, DOCKER_CLIENT_NAME];

// Definitions
const cmd_docker = 'docker';

if ((process.argv.length < 6) && (process.argv[2] !== 'clean')) {
    console.log('Use ./start-simulation.js PROTOCOL(rtmp, udp, SRT, or clean) netemCmd TestDuration(s) MediaTestFile [ffplayCommand(port2010)] [ProtocolParams]');
    console.log('Example: ./start-simulation.js udp "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "ffplay -x 1280 -y 720 -left 1680 -top 10 tcp://0.0.0.0:2010?listen"');
    console.log('Example: ./start-simulation.js srt "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "" latency=200');
    console.log('Example: ./start-simulation.js srt "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "internal" latency=200');
    console.log('');
    console.log('Clean example: start-simulation.js clean (it wil make sure all previous containers are stopped');
    console.log('');
    console.log('For more info about netem command see: http://man7.org/linux/man-pages/man8/tc-netem.8.html');

    return 1;
}

if (process.argv[2] === 'clean') {
    cleanup(cmd_docker, containerids_to_clean, -1, DOCKER_NETWORK_NAME);
    return 0;
}

// Definitions
let ffplay_ret = {};
let prot_params = "";

// Defaults
let ffplay_local_cmd = `ffplay tcp://0.0.0.0:${REPEATER_HOST_PORT}?listen`;

// Protocol
const protocol = process.argv[2];

// Netem CMD
const netem_cmd = process.argv[3];

// Test duration
const duration_s = parseInt(process.argv[4]);

// File
const media_file = process.argv[5];

// Local process (ffplay)

if (process.argv.length > 6) {
    if (process.argv[6] !== "internal") {
        ffplay_local_cmd = process.argv[6];
    }
}

// Optional protocol params
if ((process.argv.length > 7) && (process.argv[7] !== "")) {
    prot_params = process.argv[7];
}

console.log(`Start test for protocol ${protocol}, netem: ${netem_cmd}`);

// Execute FFPLAY locally
if (ffplay_local_cmd !== '') {
    const ffplay_cmd = ffplay_local_cmd.split(' ')[0];
    const ffplay_args = ffplay_local_cmd.split(' ').slice(1);
    
    ffplay_ret = executeShell(ffplay_cmd, ffplay_args, true);
    if (checkExecError(ffplay_ret) === true) {
        return 1;
    }
    else {
        console.log(`Local ffplay pid: ${ffplay_ret.pid}`);
    }
}
else {
    console.log(`ffplay should be running on your host with the following command: ffplay tcp://0.0.0.0:${REPEATER_HOST_PORT}?listen`);
}

// Create docker network
const network_args = ['network', 'create', DOCKER_NETWORK_NAME];

const netrork_ret = executeShell(cmd_docker, network_args);
if (checkExecError(netrork_ret, [], ffplay_ret.pid) === true) {
    return 1;
}

// Start repeater container
const repeater_args = ['run', '-d', '--name', `${DOCKER_REPEATER_NAME}`, '--network', DOCKER_NETWORK_NAME, '--rm', 'jcenzano/docker-ffmpeg'];

let ffmpeg_repeater_args = "";
if (protocol === 'udp') {
    ffmpeg_repeater_args = ['-i', `udp://localhost:${DOCKER_TEST_PORT}?listen`, '-c', 'copy', '-f', 'mpegts', `tcp://host.docker.internal:${REPEATER_HOST_PORT}`];
}
else if (protocol === 'rtmp') {
    ffmpeg_repeater_args = ['-listen', '1', '-i', `rtmp://0.0.0.0:${DOCKER_TEST_PORT}/live/stream`, '-c', 'copy', '-f', 'mpegts', `tcp://host.docker.internal:${REPEATER_HOST_PORT}`];
}
else if (protocol === 'srt') {
    ffmpeg_repeater_args = ['-i', `srt://0.0.0.0:${DOCKER_TEST_PORT}?mode=listener`, '-c', 'copy', '-f', 'mpegts', `tcp://host.docker.internal:${REPEATER_HOST_PORT}`];
}

const repeater_ret = executeShell(cmd_docker, repeater_args.concat(ffmpeg_repeater_args));
if (checkExecError(repeater_ret, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME) === true) {
    return 1;
}

// Start client container
const client_args = ['run', '-d', '--cap-add=NET_ADMIN', '--name', `${DOCKER_CLIENT_NAME}`, '--rm', '--network', DOCKER_NETWORK_NAME, '-v', `${path.dirname(media_file)}:${DOCKER_CLIENT_VOLUME}`, 'jcenzano/docker-ffmpeg'];

let ffmpeg_client_args = null;
if (protocol === 'udp') {
    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'mpegts', `udp://${DOCKER_REPEATER_NAME}:${DOCKER_TEST_PORT}`];
}
else if (protocol === 'rtmp') {
    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'flv', `rtmp://${DOCKER_REPEATER_NAME}:${DOCKER_TEST_PORT}/live/stream`];
}
else if (protocol === 'srt') {
    let prot_params_final = '';
    if (prot_params !== '') {
        prot_params_final = '&' + prot_params;
    }
    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'mpegts', `srt://${DOCKER_REPEATER_NAME}:${DOCKER_TEST_PORT}?mode=caller${prot_params_final}`];
}

const client_ret = executeShell(cmd_docker, client_args.concat(ffmpeg_client_args));
if (checkExecError(client_ret, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME) === true) {
    return 1;
}

if (netem_cmd !== '') {
    // FYI: It is expected to experiment a network glich when we run this command
    const netem_args = ['exec', DOCKER_CLIENT_NAME, 'sh', '-c', 'tc qdisc add dev eth0 root netem ' + netem_cmd];
    const netem_ret = executeShell(cmd_docker, netem_args);
}

// Clean up after interference
setTimeout(cleanup, duration_s * 1000, cmd_docker, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME);


// Aux functions

function checkExecError(ret, container_ids = [], pid = -1, network = null) {
    if ('error' in ret) {
        console.error(JSON.stringify(ret.error));
        return cleanup(cmd_docker, container_ids, pid, network);
    }
}

function cleanup(cmd_docker, container_ids, pid = -1, network = null) {

    if ((pid !== null) && (typeof(pid) === 'number') && (parseInt(pid) >= 0)) {
        console.log(`Killing pid: ${pid}`);
        process.kill(pid);
    }
 
    container_ids.forEach(id => {
        const cmd_stop_args = ['stop', id];

        executeShell(cmd_docker, cmd_stop_args);
    });

    if (network !== null) {
        const cmd_del_network = ['network', 'rm', network];

        executeShell(cmd_docker, cmd_del_network);
    }

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