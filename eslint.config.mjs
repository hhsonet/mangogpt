import next from "eslint-config-next";

const config = [...next, { ignores: [".next/**", "node_modules/**", "uploads/**", "imagesvc/**", "public/monaco/**", "mangolab/**"] }];

export default config;
