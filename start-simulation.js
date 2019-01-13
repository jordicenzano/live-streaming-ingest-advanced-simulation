#!/usr/bin/env node

/* jshint esversion: 6 */
/* jslint node: true */
/* global URL */ //Since Node v10
"use strict";

// Assumptions:
// docker installed & logged in
// ffplay installed in the host
// For FEC test (Brightcove only) needs pulled:
// TODO
// jcenzano/docker-fec
// jcenzano/docker-ffmpeg-fec

const path = require('path');
const cp = require('child_process');
const fs = require('fs');

// Internal definitions
const DOCKER_CLIENT_NAME = 'client';
const DOCKER_CLIENT_IP = '192.168.16.10';
const DOCKER_CLIENT_MEDIA_VOLUME = '/media';

const DOCKER_REPEATER_NAME = 'repeater';
const DOCKER_REPEATER_IP = '192.168.16.12';

const DOCKER_FEC_DECO_NAME = 'fec';
const DOCKER_FEC_IP = '192.168.16.14';
const DOCKER_FEC_CONFIG_VOLUME = '/root/fec-config';

const DOCKER_NETWORK_NAME = "test-ingest-simulation";
const DOCKER_SUBNET = '192.168.16.0/24';

// Port used
const DOCKER_TEST_PORT = 1935;
const DOCKER_FEC_TEST_PORT = DOCKER_TEST_PORT + 10;
const REPEATER_HOST_PORT = 2010;

const FEC_CONFIG_FILE_NAME = 'fec-config/fec-config.json';

const containerids_to_clean = [DOCKER_REPEATER_NAME, DOCKER_CLIENT_NAME, DOCKER_FEC_DECO_NAME];

// Definitions
const cmd_docker = 'docker';

if ((process.argv.length < 6) && (process.argv[2] !== 'clean')) {
    console.log('Use ./start-simulation.js PROTOCOL(rtmp, udp, SRT, or clean) netemCmd TestDuration(s) MediaTestFile [ffplayCommand(port2010)] [ProtocolParams]');
    console.log('Example: ./start-simulation.js udp "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "ffplay -x 1280 -y 720 -left 1680 -top 10 tcp://0.0.0.0:2010?listen"');
    console.log('Example: ./start-simulation.js srt "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "" latency=200');
    console.log('Example: ./start-simulation.js srt "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "internal" latency=200');
    console.log('Example: ./start-simulation.js rtmp "rate 10mbps loss 5% delay 200ms" /test-video/test.ts');
    console.log('Example(*): ./start-simulation.js fec "rate 10mbps loss 5% delay 200ms" /test-video/test.ts "internal" "c=10 l=10"');
    console.log('');
    console.log('Clean example: start-simulation.js clean (it wil make sure all previous containers are stopped');
    console.log('');
    console.log('For more info about netem command see: http://man7.org/linux/man-pages/man8/tc-netem.8.html');
    console.log('');
    console.log('(*) Fec only available for Brightcove users');

    return 1;
}

if (process.argv[2] === 'clean') {
    cleanup(cmd_docker, containerids_to_clean, -1, DOCKER_NETWORK_NAME, FEC_CONFIG_FILE_NAME);
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
else {
    // Set default
    if (protocol === 'fec') {
        prot_params = 'l=8:d=4';
    }
}


console.log(`Start test for protocol ${protocol}, prot params: ${prot_params}, network (netem cmd): ${netem_cmd}`);

// Execute FFPLAY locally
if (ffplay_local_cmd !== '') {
    const ffplay_cmd = ffplay_local_cmd.split(' ')[0];
    const ffplay_args = ffplay_local_cmd.split(' ').slice(1);
    
    ffplay_ret = executeShell(ffplay_cmd, ffplay_args, true);
    if (checkExecError(cmd_docker, ffplay_ret) === true) {
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
const network_args = ['network', 'create', DOCKER_NETWORK_NAME, `--subnet=${DOCKER_SUBNET}`];

const netrork_ret = executeShell(cmd_docker, network_args);
if (checkExecError(cmd_docker, netrork_ret, [], ffplay_ret.pid) === true) {
    return 1;
}

// Start repeater container
const repeater_args = ['run', '-d', '--name', `${DOCKER_REPEATER_NAME}`, '--network', DOCKER_NETWORK_NAME, `--ip=${DOCKER_REPEATER_IP}`, '--rm', 'jcenzano/docker-ffmpeg'];

let ffmpeg_repeater_args = "";
if ((protocol === 'udp') || (protocol === 'fec')) {
    ffmpeg_repeater_args = ['-i', `udp://localhost:${DOCKER_TEST_PORT}?listen`, '-c', 'copy', '-f', 'mpegts', `tcp://host.docker.internal:${REPEATER_HOST_PORT}`];
}
else if (protocol === 'rtmp') {
    ffmpeg_repeater_args = ['-listen', '1', '-i', `rtmp://0.0.0.0:${DOCKER_TEST_PORT}/live/stream`, '-c', 'copy', '-f', 'mpegts', `tcp://host.docker.internal:${REPEATER_HOST_PORT}`];
}
else if (protocol === 'srt') {
    ffmpeg_repeater_args = ['-i', `srt://0.0.0.0:${DOCKER_TEST_PORT}?mode=listener`, '-c', 'copy', '-f', 'mpegts', `tcp://host.docker.internal:${REPEATER_HOST_PORT}`];
}

const repeater_ret = executeShell(cmd_docker, repeater_args.concat(ffmpeg_repeater_args));
if (checkExecError(cmd_docker, repeater_ret, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME) === true) {
    return 1;
}

// Launch FEC decoder container if FEC is used
if (protocol === 'fec') {
    const config_file_name = createFECConfig(FEC_CONFIG_FILE_NAME, DOCKER_REPEATER_IP, DOCKER_CLIENT_IP, DOCKER_FEC_TEST_PORT, DOCKER_TEST_PORT);

    const fec_args = ['run', '-d', '--name', `${DOCKER_FEC_DECO_NAME}`, '--network', DOCKER_NETWORK_NAME, `--ip=${DOCKER_FEC_IP}`, '-v', `${path.dirname(config_file_name)}:${DOCKER_FEC_CONFIG_VOLUME}`, '--rm', 'jcenzano/docker-fec', path.join(DOCKER_FEC_CONFIG_VOLUME, path.basename(config_file_name))];

    const fec_ret = executeShell(cmd_docker, fec_args);
    if (checkExecError(cmd_docker, fec_ret, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME, config_file_name) === true) {
        return 1;
    }
}

// Start client container
const client_args = ['run', '-d', '--cap-add=NET_ADMIN', '--name', `${DOCKER_CLIENT_NAME}`, '--rm', '--network', DOCKER_NETWORK_NAME, `--ip=${DOCKER_CLIENT_IP}`, '-v', `${path.dirname(media_file)}:${DOCKER_CLIENT_MEDIA_VOLUME}`];

let ffmpeg_client_args = null;
if (protocol === 'udp') {
    client_args.push('jcenzano/docker-ffmpeg');

    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_MEDIA_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'mpegts', `udp://${DOCKER_REPEATER_IP}:${DOCKER_TEST_PORT}`];
}
else if (protocol === 'rtmp') {
    client_args.push('jcenzano/docker-ffmpeg');

    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_MEDIA_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'flv', `rtmp://${DOCKER_REPEATER_IP}:${DOCKER_TEST_PORT}/live/stream`];
}
else if (protocol === 'srt') {
    client_args.push('jcenzano/docker-ffmpeg');

    let prot_params_final = '';
    if (prot_params !== '') {
        prot_params_final = '&' + prot_params;
    }
    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_MEDIA_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'mpegts', `srt://${DOCKER_REPEATER_IP}:${DOCKER_TEST_PORT}?mode=caller${prot_params_final}`];
}
else if (protocol === 'fec') {
    client_args.push('jcenzano/docker-ffmpeg-fec');

    ffmpeg_client_args = ['-re', '-i', path.join(DOCKER_CLIENT_MEDIA_VOLUME, path.basename(media_file)), '-c', 'copy', '-f', 'rtp_mpegts', '-fec', `prompeg=${prot_params}`,`rtp://${DOCKER_FEC_IP}:${DOCKER_FEC_TEST_PORT}`];
}

const client_ret = executeShell(cmd_docker, client_args.concat(ffmpeg_client_args));
if (checkExecError(cmd_docker, client_ret, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME, FEC_CONFIG_FILE_NAME) === true) {
    return 1;
}

if (netem_cmd !== '') {
    const netem_args = ['exec', DOCKER_CLIENT_NAME, 'sh', '-c', 'tc qdisc add dev eth0 root netem ' + netem_cmd];
    const netem_ret = executeShell(cmd_docker, netem_args);
}

// Clean up after interference
setTimeout(cleanup, duration_s * 1000, cmd_docker, containerids_to_clean, ffplay_ret.pid, DOCKER_NETWORK_NAME, FEC_CONFIG_FILE_NAME);


// Aux functions

function createFECConfig(conf_file_name, docker_repeater_ip, docker_client_ip, fec_rx_port, clean_tx_port) {
    const fec_conf = {
        "version": 1,
        "development": { "disableErrorCorrection": false, "packetLoss": 0.0},
        "output": {
            "protocol": "udp",
            "ip": docker_repeater_ip, //TODO, only IP?
            "port": clean_tx_port
        },
        "input": {
            "basePort": fec_rx_port,
            "whitelist": [docker_client_ip]
        }
    };

    fs.writeFileSync(conf_file_name, JSON.stringify(fec_conf));

    return path.resolve(conf_file_name);
}

function checkExecError(cmd_docker, ret, container_ids = [], pid = -1, network = null, fec_config_filename = null) {
    if ('error' in ret) {
        console.error(JSON.stringify(ret.error));
        return cleanup(cmd_docker, container_ids, pid, network, fec_config_filename);
    }
}

function cleanup(cmd_docker, container_ids, pid = -1, network = null, fec_config_file = null) {

    if ((pid !== null) && (typeof(pid) === 'number') && (parseInt(pid) >= 0)) {
        console.log(`Killing pid: ${pid}`);
        process.kill(pid);
    }

    if ((fec_config_file !== null) && (fs.existsSync(fec_config_file))) {
        fs.unlinkSync(fec_config_file);
        console.log(`Deleted FEC config file: ${fec_config_file}`);
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
