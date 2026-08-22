//! lightpipe optical core.
//!
//! Pure: no I/O, no DOM, no camera, no network (ADR-0009). The whole system is
//! `bytes -> Vec<RgbImage>` and `Vec<RgbImage> -> bytes`, which makes every layer
//! testable against the channel simulator with no hardware.

pub mod codec;
pub mod fountain;
pub mod frame;
pub mod geometry;
pub mod header;
pub mod image;
pub mod modem;
pub mod palette;
pub mod pipeline;
pub mod sim;

pub use frame::FrameSpec;
pub use image::RgbImage;
pub use palette::{Palette, P2, P4, P8};
pub use sim::Channel;
