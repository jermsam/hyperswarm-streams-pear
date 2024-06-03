import b4a from 'b4a';
import {deserialize, serialize} from 'bson';

export  function encodeChunk(chunk) {
  const { type, timestamp, duration, byteLength } = chunk;
  const data = new Uint8Array(byteLength); // Create a new Uint8Array
  chunk.copyTo(data); // Copy data from the chunk to the array
  const bsonData = {
    type,
    timestamp,
    duration,
    byteLength,
    data: b4a.from(data.buffer)  // Convert ArrayBuffer to Buffer
  };

  return b4a.from(serialize(bsonData)); // Serialize to BSON and then to Buffer
}
//
export function decodeChunk(encoded) {
  const bsonData = deserialize(b4a.toBuffer(encoded)); // Deserialize BSON to object
  const { type, timestamp, duration, byteLength, data } = bsonData;
  const arrayBuffer = data.buffer; // Convert Buffer back to ArrayBuffer
  const decodedBsonData = {
    type,
    timestamp,
    duration,
    byteLength,
    data: arrayBuffer  // Convert ArrayBuffer to Buffer
  };
  return new EncodedVideoChunk(decodedBsonData);
}
