import crypto from 'hypercore-crypto'; // Cryptographic functions for generating the key in app
import b4a from 'b4a';                 // Module for buffer-to-string and vice-versa conversions
import {swarm} from './network.js';
import {decodeChunk, encodeChunk} from './video.js';
import {createObservableMap} from './utils.js';
import {deserialize, serialize} from 'bson';

let cameraOn = false; // should be shared across peers
let remoteUsers = createObservableMap();
let localPublicKey;

async function receiveChunksFromPeer(peersNoisePublicKey, chunk) {
  const {writer} = remoteUsers.get(peersNoisePublicKey);
  if (writer) {
    try {
      await writer.write(chunk);
    } catch (e) {
      console.error('Error writing chunk to the pipeline:', e);
    }
  }
}

// When there's a new connection, listen for new video streams, and add them to the UI
swarm.on('connection', (socket, peerInfo) => {
  const peersNoisePublicKey = b4a.toString(peerInfo.publicKey, 'hex');
  console.log({peersNoisePublicKey});
  localPublicKey = b4a.toString(socket.publicKey, 'hex');
  console.log({localPublicKey});
  // Check if stream exists for this peer
  onPeerJoined(peersNoisePublicKey);

  socket.on('data', async (chunk) => {
    const bsonData = deserialize(b4a.toBuffer(chunk));
    if(bsonData.type === 'camera') {
      const {id, value} = bsonData;

      if(value === 'off') {
        onPeerLeft(id)
        removePeerVideo(id)
      } else if (value === 'on') {
        onPeerJoined(id)
        addPeerVideo(id)
      }
    } else {
      await receiveChunksFromPeer(peersNoisePublicKey, chunk);
    }
  });

  socket.once('close', async () => {
    onPeerLeft(peersNoisePublicKey);
  });

  socket.once('error', (err) => {
    console.log(err);
  })

});

// When there's updates to the swarm, update the peers count
swarm.on('update', () => {
  document.querySelector('#peers-count').textContent = swarm.connections.size;
});

// swarm.on('error', () => {
//   console.error('Error writing swarm:', swarm);
// })

document.querySelector('#create-chat-room').addEventListener('click', createChatRoom);
document.querySelector('#join-form').addEventListener('submit', joinChatRoom);

async function joinSwarm(topicBuffer) {
  document.querySelector('#setup').classList.add('hidden');
  document.querySelector('#loading').classList.remove('hidden');
  swarm.join(topicBuffer);
  document.querySelector('#chat-room-topic').innerText = b4a.toString(topicBuffer, 'hex');
  document.querySelector('#loading').classList.add('hidden');
  document.querySelector('#chat').classList.remove('hidden');
}


async function leaveSwarm(topicBuffer) {

  // Stop local stream if camera is on
  if (cameraOn) {
    await stopLocalStream();
    cameraOn = false;
  }
  document.querySelector('#setup').classList.remove('hidden');
  document.querySelector('#loading').classList.remove('hidden');

  await Promise.all([...swarm.connections].map(socket => socket.end()))
  if (topicBuffer) await swarm.leave(topicBuffer)
  await swarm.destroy()
  document.querySelector('#chat-room-topic').innerText = '';
  document.querySelector('#loading').classList.add('hidden');
  document.querySelector('#chat').classList.add('hidden');
}

async function createChatRoom() {
  const chanelKeyByte = crypto.randomBytes(32);
  await joinSwarm(chanelKeyByte);
}

async function joinChatRoom(e) {
  e.preventDefault();
  const topicStr = document.querySelector('#join-chat-room-topic').value;
  const topicBuffer = b4a.from(topicStr, 'hex');
  await joinSwarm(topicBuffer);
}

async function leaveChatRoom(e) {
  e?.preventDefault();
  const topicStr = document.querySelector('#join-chat-room-topic').value;
  const topicBuffer = b4a.from(topicStr, 'hex');
  console.log({topicBuffer});
  await leaveSwarm(topicBuffer);
}

document.querySelector('#leave-btn').addEventListener('click', leaveChatRoom);

const cameraButton = document.getElementById('camera-btn');
const videoStreamsContainer = document.getElementById('video-streams');

function addLocalVideo(stream) {
  const existingVideoElement = document.getElementById(`video-local`);
  if (existingVideoElement) {
    existingVideoElement.srcObject = stream;
  } else {
    const video = document.createElement('video');
    video.id = `video-local`;
    video.classList.add('video-container');
    video.style.width = '100%';
    video.style.height = '100%';
    video.autoplay = true;
    video.srcObject = stream;

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    videoContainer.id = 'user-container-local';

    videoContainer.appendChild(video);
    videoStreamsContainer.appendChild(videoContainer);
  }
}

async function startLocalStream() {

  const stream = await navigator.mediaDevices.getUserMedia({video: true});
  const [videoTrack] = stream.getVideoTracks();

  const mediaProcessor = new MediaStreamTrackProcessor({track: videoTrack});


  const generator = new MediaStreamTrackGenerator({kind: 'video'});

  const encoderTransformStream = new TransformStream({
    start(controller) {
      this.frameCounter = 0;
      this.keyFrameInterval = 150; // Generate a key frame every 150 frame
      this.encoder = new VideoEncoder({
        output: async (chunk) => {
          const encoded = encodeChunk(chunk);
          // Send the message to all peers (that you are connected to)
          // Send the chunk to all connected peers
          const peers = [...swarm.connections];
          for (const peer of peers) {
            //  check if the stream is writable before attempting to write to it.
            if (peer.opened) {
              try {
                peer.write(encoded);
              } catch (error) {
                console.error('Error writing to peer stream:', error);
              }
            }
          }
          controller.enqueue(encoded);
        },
        error: (error) => {
          console.error('VideoEncoder error:', error);
        },
      });
      const {width, height} = videoTrack.getSettings();

      this.encoder.configure({
        codec: 'vp8',
        width,
        height,
        bitrate: 2_000_000,
        framerate: 30,
      });
    },
    async transform(frame) {
      if (this.encoder.encodeQueueSize > 2) {
        frame.close();
      } else {
        /**
         * In video encoding and streaming, ensuring that peers who join later can correctly decode the video stream
         * requires transmitting key frames periodically and marking them appropriately.
         * Key frames (also known as intra frames) are self-contained frames that can be decoded independently,
         * unlike other frames (inter frames) that rely on previous frames for decoding.
         * */
        const insertKeyFrame = this.frameCounter % this.keyFrameInterval === 0;
        this.encoder.encode(frame, {keyFrame: insertKeyFrame});
        this.frameCounter++;
        frame.close();
      }
    },
    flush() {
      this.encoder.flush();
    },
  });

  const decoderTransformStream = new TransformStream({
    start(controller) {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          controller.enqueue(frame);
        },
        error: (error) => console.error('VideoDecoder error:', error),
      });
      this.decoder.configure({codec: 'vp8'});
    },
    async transform(chunk) {
      const decodedChunk = decodeChunk(chunk);
      this.decoder.decode(decodedChunk);
    },
  });

  mediaProcessor.readable
    .pipeThrough(encoderTransformStream)
    .pipeThrough(decoderTransformStream)
    .pipeTo(generator.writable);

  const mediaStream = new MediaStream([generator]);

  addLocalVideo(mediaStream);

 // Get the writer for the processor
  remoteUsers.set('local', {videoTrack, generator});
  cameraOn = true;
  const peers = [...swarm.connections];
  for (const peer of peers) {
    if (peer.opened) {
      try {
        const bsonData = {
          type: 'camera', id: localPublicKey, value: 'on'
        };
        peer.write(b4a.from(serialize(bsonData)));
      } catch (error) {
        console.error('Error notifying peer about stopping stream:', error);
      }
    }
  }
}

async function stopLocalStream() {
  const existingVideo = document.getElementById(`video-local`);
  if (remoteUsers.has('local')) {
    const {videoTrack, generator} = remoteUsers.get('local');
    videoTrack.stop();
    generator.stop();
    remoteUsers.delete('local');
  }
  existingVideo.currentTime = 0;
  existingVideo.srcObject = null;
  cameraOn = false;
  // Notify peers that the local stream has stopped
  const peers = [...swarm.connections];
  for (const peer of peers) {
    if (peer.opened) {
      try {
        const bsonData = {
          type: 'camera', id: localPublicKey, value: 'off'
        };
        peer.write(b4a.from(serialize(bsonData)));
      } catch (error) {
        console.error('Error notifying peer about stopping stream:', error);
      }
    }
  }
}

cameraButton.addEventListener('click', async () => {
  if (cameraOn) {
    await stopLocalStream();
    cameraButton.innerHTML = 'Camera On';
  } else {
    await startLocalStream();
    cameraButton.innerHTML = 'Camera Off';
  }
});

remoteUsers.onAdd((key) => {
  addPeerVideo(key);
});

remoteUsers.onRemove((key) => {
  removePeerVideo(key);
});

function onPeerJoined(remotePeerPrimaryKey) {
  if (!remoteUsers.has(remotePeerPrimaryKey)) {
    const transformer = new TransformStream({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
      },
    });

    const decoderTransformStream = new TransformStream({
      start(controller) {
        this.decoder = new VideoDecoder({
          output: (frame) => {
            controller.enqueue(frame);
          },
          error: (error) => console.error('VideoDecoder error:', error),
        });
        this.started = false;
        this.decoder.configure({codec: 'vp8'});
      },
      async transform(chunk, controller) {
        const decoded = decodeChunk(chunk);
        if (decoded instanceof EncodedVideoChunk) {
          /**
           * When a new peer joins, it's important to ensure they receive a key frame to initialize their decoder properly.
           * Decode Key Frames First: Ensure that the key frame is decoded first for new peers.
           * */
          if (decoded.type === 'key') {
            await this.decoder.decode(decoded); // Decode the key frame first
            this.started = true;
          } else if (this.started) {
            await this.decoder.decode(decoded);
          }

        } else if (!controller.closed) {
          controller.enqueue(chunk);
        }
      },
      async flush() {
        // After receiving all chunks, decode any remaining non-key frames

      },
    });
    const generator = new MediaStreamTrackGenerator({kind: 'video'});
    const writer = transformer.writable.getWriter();
    transformer.readable
      .pipeThrough(decoderTransformStream)
      .pipeTo(generator.writable);
    remoteUsers.set(remotePeerPrimaryKey, {transformer, writer, generator});
  }
}

function onPeerLeft(remotePeerPrimaryKey) {
  console.log(`Peer left: ${remotePeerPrimaryKey}`);
  if (remoteUsers.has(remotePeerPrimaryKey)) {
    const { transformer, writer, generator} = remoteUsers.get(remotePeerPrimaryKey);

    // Stop the MediaStreamTrackGenerator
    generator.stop();

    // Properly close the streams and clean up
    writer.close().catch((error) => console.error('Error closing writer stream:', error));

    if(!transformer.readable.locked) {
      // Properly close the streams and clean up
      transformer.readable.cancel().catch((error) => console.error('Error canceling readable stream:', error));
    }

    remoteUsers.delete(remotePeerPrimaryKey);
  }
}

function addPeerVideo(remotePeerPrimaryKey) {
  const {generator} = remoteUsers.get(remotePeerPrimaryKey);
  const mediaStream = new MediaStream([generator]);
  const existingVideoElement = document.getElementById(`video-${remotePeerPrimaryKey}`);
  if (existingVideoElement) {
    existingVideoElement.srcObject = mediaStream;
  } else {
    const remoteVideo = document.createElement('video');
    remoteVideo.id = `video-${remotePeerPrimaryKey}`;
    remoteVideo.classList.add('video-container');
    remoteVideo.style.width = '100%';
    remoteVideo.style.height = '100%';
    remoteVideo.autoplay = true;

    remoteVideo.srcObject = mediaStream;

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    videoContainer.id = `user-container-${remotePeerPrimaryKey}`;
    videoContainer.appendChild(remoteVideo);
    videoStreamsContainer.appendChild(videoContainer);
  }
}

function removePeerVideo(key) {
  remoteUsers.delete(key); // Ensure the peer is removed from the map
  const idToRemove = `user-container-${key}`;
  const elementToRemove = document.getElementById(idToRemove);
  if (elementToRemove) {
    elementToRemove.remove(); // Remove the video element from the DOM
  }
}

