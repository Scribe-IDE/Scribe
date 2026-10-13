# %% [markdown]
# Analysis notebook (Jupytext percent format).
# Cells tagged `[figure: <id>]` will export to figures/<id>.pdf in step 2.

# %%
import numpy as np
import matplotlib.pyplot as plt

epochs = np.arange(1, 51)
loss = np.exp(-epochs / 12) + 0.02 * np.random.rand(50)

# %% [figure: fig-loss]
plt.plot(epochs, loss)
plt.xlabel("Epoch"); plt.ylabel("Loss")
