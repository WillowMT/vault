# Video Gallery Navigation Design

## Goal

Let users browse videos in the preview dialog with the same visible arrows and left/right keyboard navigation used for image galleries.

## Behavior

- When the current filtered or folder view contains two or more videos, opening a video shows previous and next controls over the video preview.
- Left and right arrow keys navigate to the previous and next video, respectively.
- Navigation wraps at both ends of the video list.
- Image and video galleries remain separate, so navigating from an image never opens a video and vice versa.
- Switching previews stops and releases the previous video through the existing preview cleanup path.

## Implementation

- The browser app will provide separate filtered image and video entry lists to the preview module.
- The preview module will select the gallery that matches the previewed entry category and reuse its existing arrow and keyboard navigation mechanism.
- A Happy DOM browser test will cover visible video arrows, click navigation, keyboard wrapping, and dialog cleanup.
